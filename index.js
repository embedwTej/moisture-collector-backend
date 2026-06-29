const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Configure environment variables
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/moisture_collector';
const VENDOR_API_URL = process.env.VENDOR_API_URL || '';
const SAP_API_URL = process.env.SAP_API_URL || '';

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB database'))
  .catch(err => console.error('MongoDB database connection error:', err));

// ══════════════════════════════════════════════════════
// DATABASE SCHEMAS & MODELS
// ══════════════════════════════════════════════════════

// 1. Authorized Devices (Locks app to 10-15 industrial devices)
const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true },
  name: { type: String, default: 'Industrial Phone' },
  isActive: { type: Boolean, default: true },
  registeredAt: { type: Date, default: Date.now }
});
const Device = mongoose.model('Device', DeviceSchema);

// 2. Concurrency Locks (Auto-expires after 10 minutes = 600 seconds)
const LockSchema = new mongoose.Schema({
  gateEntryNo: { type: String, unique: true, required: true },
  deviceId: { type: String, required: true },
  operatorName: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 } // TTL index
});
const Lock = mongoose.model('Lock', LockSchema);
// 3. Completed Submissions (Audit Log)
const SubmissionSchema = new mongoose.Schema({
  gateEntryNo: { type: String, unique: true, required: true },
  vehicleNo: { type: String, required: true },
  productName: { type: String, required: true },
  averageMoisture: { type: Number, required: true },
  operatorName: { type: String, required: true },
  submittedByDevice: { type: String, required: true },
  submittedAt: { type: Date, default: Date.now }
});
const Submission = mongoose.model('Submission', SubmissionSchema);
// 4. Active Vehicles (Dynamic gate entries populated via admin utility)
const VehicleSchema = new mongoose.Schema({
  gateEntryNo: { type: String, unique: true, required: true },
  vehicleNo: { type: String, required: true },
  productName: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Vehicle = mongoose.model('Vehicle', VehicleSchema);

// ══════════════════════════════════════════════════════
// MIDDLEWARE FOR SECURITY
// ══════════════════════════════════════════════════════

// Verifies X-Device-ID header. Whitelists first device automatically.
const verifyDevice = async (req, res, next) => {
  const deviceId = req.headers['x-device-id'] || req.query.deviceId;
  if (!deviceId) {
    return res.status(401).json({ error: 'Unauthorized: Missing X-Device-ID header' });
  }

  try {
    const deviceCount = await Device.countDocuments();
    if (deviceCount === 0) {
      // Auto-bootstrap: Whitelist first phone that connects
      await Device.create({ deviceId, name: 'Main Admin Handset', isActive: true });
      console.log(`Auto-bootstrapped main device: ${deviceId}`);
    }

    const authorizedDevice = await Device.findOne({ deviceId, isActive: true });
    if (!authorizedDevice) {
      return res.status(403).json({ error: 'Device blocked. Contact administrator to whitelist.' });
    }

    req.deviceId = deviceId;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Security verification error' });
  }
};

// Apply security check to all client endpoints
app.use('/api/v1/gate-entries', verifyDevice);
app.use('/api/v1/paddy', verifyDevice);

// ══════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════

// 1. Fetch Active Paddy Shipments
app.get('/api/v1/gate-entries/paddy-only', async (req, res) => {
  try {
    let entries = [];    // Pull from Vendor API if configured
    if (VENDOR_API_URL) {
      const response = await axios.get(VENDOR_API_URL);
      entries = response.data;
    } else {
      // Pull from our custom Database-driven Vehicles collection if populated
      const dbVehicles = await Vehicle.find({});
      entries = dbVehicles.map(v => ({
        gateEntryNo: v.gateEntryNo,
        vehicleNo: v.vehicleNo,
        productName: v.productName
      }));
    }
    // Find all active locks and completed submissions
    const activeLocks = await Lock.find({});
    const completedSubmissions = await Submission.find({}, 'gateEntryNo');

    const lockMap = new Map(activeLocks.map(l => [l.gateEntryNo, { operatorName: l.operatorName, deviceId: l.deviceId }]));
    const completedSet = new Set(completedSubmissions.map(s => s.gateEntryNo));

    const finalEntries = entries
      .filter(e => !completedSet.has(e.gateEntryNo))
      .map(e => {
        const lockInfo = lockMap.get(e.gateEntryNo);
        return {
          gateEntryNo: e.gateEntryNo,
          vehicleNo: e.vehicleNo,
          productName: e.productName,
          status: lockInfo ? 'LOCKED' : 'FREE',
          lockedBy: lockInfo ? lockInfo.operatorName : null,
          lockedByDeviceId: lockInfo ? lockInfo.deviceId : null
        };
      });

    res.json(finalEntries);
  } catch (err) {
    console.error('Error fetching shipments:', err.message);
    res.status(500).json({ error: 'Failed to retrieve shipments' });
  }
});

// 2. Acquire Concurrency Lock
app.post('/api/v1/gate-entries/:gateEntryNo/lock', async (req, res) => {
  const { gateEntryNo } = req.params;
  const { deviceId, operatorName } = req.body;

  if (!deviceId || !operatorName) {
    return res.status(400).json({ success: false, message: 'Missing operator details' });
  }

  try {
    // Try to create the lock (Atomic operation)
    await Lock.create({ gateEntryNo, deviceId, operatorName });
    res.json({ success: true, message: 'Lock acquired' });
  } catch (err) {
    if (err.code === 11000) {
      const existing = await Lock.findOne({ gateEntryNo });
      if (existing && existing.deviceId === deviceId) {
        existing.operatorName = operatorName;
        existing.createdAt = new Date();
        await existing.save();
        return res.json({ success: true, message: 'Lock renewed/re-acquired by same device' });
      }
      const holder = existing ? existing.operatorName : 'another operator';
      res.status(409).json({
        success: false,
        message: `This vehicle is currently locked by ${holder}.`
      });
    } else {
      res.status(500).json({ success: false, message: 'Server error acquiring lock' });
    }
  }
});

// 3. Release Concurrency Lock
app.delete('/api/v1/gate-entries/:gateEntryNo/lock', async (req, res) => {
  const { gateEntryNo } = req.params;
  const { deviceId } = req.query;

  try {
    // Only allow releasing if the device matches the lock holder
    const deleted = await Lock.findOneAndDelete({ gateEntryNo, deviceId });
    if (deleted) {
      res.json({ success: true, message: 'Lock released' });
    } else {
      res.status(404).json({ success: false, message: 'Lock not found or owned by another device' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error releasing lock' });
  }
});

// 4. Submit Moisture Report
app.post('/api/v1/paddy/submit-moisture', async (req, res) => {
  const { gateEntryNo, vehicleNo, productName, averageMoisture, operatorName } = req.body;

  if (!gateEntryNo || !vehicleNo || !productName || !averageMoisture || !operatorName) {
    return res.status(400).json({ success: false, message: 'Missing report data (gateEntryNo, vehicleNo, productName, averageMoisture, or operatorName)' });
  }

  try {
    // Prevent duplicate entries
    const alreadySubmitted = await Submission.findOne({ gateEntryNo });
    if (alreadySubmitted) {
      return res.status(400).json({ success: false, message: 'This shipment has already been completed.' });
    }

    // Save to Database (Audit Log)
    await Submission.create({
      gateEntryNo,
      vehicleNo,
      productName,
      averageMoisture,
      operatorName,
      submittedByDevice: req.deviceId
    });

    // Remove lock
    await Lock.findOneAndDelete({ gateEntryNo });

    // Sync to external SAP system if configured (sends only gateEntryNo, vehicleNo, and averageMoisture)
    if (SAP_API_URL) {
      try {
        await axios.post(SAP_API_URL, { gateEntryNo, vehicleNo, averageMoisture });
      } catch (sapErr) {
        console.error('Failed to sync to SAP directly:', sapErr.message);
      }
    }

    res.json({ success: true, message: 'Submission successful' });
  } catch (err) {
    console.error('Error submitting report:', err.message);
    res.status(500).json({ success: false, message: 'Server error registering report' });
  }
});
// ══════════════════════════════════════════════════════
// ADMIN ENDPOINTS (To manage authorized devices)
// ══════════════════════════════════════════════════════

// Add a device whitelist entry
app.post('/api/v1/admin/devices', async (req, res) => {
  const { deviceId, name } = req.body;
  try {
    const dev = await Device.create({ deviceId, name });
    res.json({ success: true, device: dev });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// View all authorized devices
app.get('/api/v1/admin/devices', async (req, res) => {
  try {
    const devices = await Device.find({});
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a device
app.delete('/api/v1/admin/devices/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    await Device.findOneAndDelete({ deviceId });
    res.json({ success: true, message: 'Device removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a vehicle gate entry (used by the admin utility to push vehicle data)
app.post('/api/v1/admin/gate-entries', async (req, res) => {
  const { gateEntryNo, vehicleNo, productName } = req.body;
  if (!gateEntryNo || !vehicleNo || !productName) {
    return res.status(400).json({ success: false, message: 'Missing gateEntryNo, vehicleNo, or productName' });
  }

  try {
    const vehicle = await Vehicle.create({ gateEntryNo, vehicleNo, productName });
    res.json({ success: true, vehicle });
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ success: false, message: 'Gate Entry Number already exists' });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// View all vehicle gate entries
app.get('/api/v1/admin/gate-entries', async (req, res) => {
  try {
    const vehicles = await Vehicle.find({}).sort({ createdAt: -1 });
    res.json(vehicles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a vehicle gate entry
app.delete('/api/v1/admin/gate-entries/:gateEntryNo', async (req, res) => {
  const { gateEntryNo } = req.params;
  try {
    await Vehicle.findOneAndDelete({ gateEntryNo });
    res.json({ success: true, message: 'Vehicle entry removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Moisture Collector Backend API running on port ${PORT}`);
  });
}
module.exports = app;
