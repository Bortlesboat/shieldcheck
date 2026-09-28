import { createHmac } from 'node:crypto';

export function claimProof(capability, orderId, challenge) {
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(`shieldcheck-claim/v1\n${orderId}\n${challenge}`)
    .digest('hex');
}
