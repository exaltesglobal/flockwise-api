// CommonJS startup file for hosts that require() the entry (Hostinger / Passenger).
// Set the entry file to server.cjs if dist/index.js does not start there.
import('./dist/index.js').catch((e) => {
  console.error('Flockwise API failed to start', e);
  process.exit(1);
});
