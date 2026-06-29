const axios = require('axios');

// Read command line arguments
const args = process.argv.slice(2);
const gateEntryNo = args[0];
const vehicleNo = args[1];
const productName = args[2] || 'Paddy (Whole)';
const apiUrl = process.env.API_URL || 'http://localhost:3000';

// Usage helper
if (!gateEntryNo || !vehicleNo) {
  console.log(`
Usage:
  node push-vehicle.js <gateEntryNo> <vehicleNo> [productName]

Example:
  node push-vehicle.js "GE/2026/00999" "PB-65-XY-7788" "Paddy (Whole)"

To set a custom API server URL (e.g. Render):
  On Windows (PowerShell):
    $env:API_URL="https://your-api.onrender.com"
    node push-vehicle.js "GE/2026/00999" "PB-65-XY-7788"

  On Linux/Mac:
    API_URL="https://your-api.onrender.com" node push-vehicle.js "GE/2026/00999" "PB-65-XY-7788"
  `);
  process.exit(1);
}

const payload = {
  gateEntryNo,
  vehicleNo,
  productName
};

console.log(`Sending vehicle to API at: ${apiUrl}...`);
console.log('Payload:', JSON.stringify(payload, null, 2));

axios.post(`${apiUrl}/api/v1/admin/gate-entries`, payload)
  .then(response => {
    if (response.data.success) {
      console.log('\n✅ Success! Vehicle added to database.');
      console.log('Database Record:', response.data.vehicle);
    } else {
      console.log('\n❌ Failed:', response.data.message);
    }
  })
  .catch(error => {
    console.error('\n❌ Network or Server Error:');
    if (error.response) {
      console.error(`Status Code: ${error.response.status}`);
      console.error('Response Data:', error.response.data);
    } else {
      console.error(error.message);
    }
  });
