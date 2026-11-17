import { chargeLegacy } from '../legacy/payments.js';
// Old PSP still posts refunds to this endpoint for contracts signed before 2024.
export function onRefund(cents: number) { return chargeLegacy(-cents); }
