import { readFileSync } from 'node:fs';
import pkg from '@stellar/stellar-sdk';
const { xdr } = pkg;

// Pull every base64 spec string out of bindings.ts.
const src = readFileSync('src/games/clash/bindings.ts', 'utf8');
const b64s = [...src.matchAll(/"([A-Za-z0-9+/]{40,}={0,2})"/g)].map((m) => m[1]);

let accept = null;
for (const b of b64s) {
  let entry;
  try {
    entry = xdr.ScSpecEntry.fromXDR(b, 'base64');
  } catch {
    continue;
  }
  if (entry.switch().name === 'scSpecEntryFunctionV0') {
    const fn = entry.functionV0();
    if (Buffer.from(fn.name()).toString() === 'accept_challenge') {
      accept = { b, fn };
      break;
    }
  }
}

if (!accept) {
  console.error('accept_challenge spec entry not found');
  process.exit(1);
}

const fn = accept.fn;
console.log('accept_challenge inputs:', fn.inputs().map((i) => `${Buffer.from(i.name()).toString()}:${i.type().switch().name}`));
console.log('accept_challenge outputs count:', fn.outputs().length, fn.outputs().map((o) => o.switch().name));

// Build decline_challenge: inputs [challenge_id: u32, caller: address], same outputs (Result<void>).
const u32In = fn.inputs()[0]; // challenge_id : u32
const addrTemplate = fn.inputs()[1]; // challenged : address

const challengeIdInput = new xdr.ScSpecFunctionInputV0({
  doc: '',
  name: 'challenge_id',
  type: u32In.type(),
});
const callerInput = new xdr.ScSpecFunctionInputV0({
  doc: '',
  name: 'caller',
  type: addrTemplate.type(),
});

const declineFn = new xdr.ScSpecFunctionV0({
  doc: 'Decline (challenged) or cancel (challenger) a pending challenge.',
  name: 'decline_challenge',
  inputs: [challengeIdInput, callerInput],
  outputs: fn.outputs(),
});

const declineEntry = xdr.ScSpecEntry.scSpecEntryFunctionV0(declineFn);
const out = declineEntry.toXDR('base64');

// Verify round-trip.
const rt = xdr.ScSpecEntry.fromXDR(out, 'base64').functionV0();
console.log('decline_challenge inputs:', rt.inputs().map((i) => `${Buffer.from(i.name()).toString()}:${i.type().switch().name}`));
console.log('decline_challenge outputs:', rt.outputs().map((o) => o.switch().name));
console.log('\nBASE64:');
console.log(out);
