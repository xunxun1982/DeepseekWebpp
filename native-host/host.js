#!/usr/bin/env node
const { handleMessage } = require('./host-core');

let input = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  readAvailableMessages().catch((error) => {
    writeMessage({ ok: false, error: error.message });
  });
});

async function readAvailableMessages() {
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) {
      return;
    }

    const body = input.subarray(4, length + 4).toString('utf8');
    input = input.subarray(length + 4);
    const response = await handleMessage(JSON.parse(body));
    writeMessage(response);
  }
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
