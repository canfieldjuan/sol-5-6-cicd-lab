export async function submitPayment(payment, send, createId) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await send({ ...payment, idempotencyKey: createId() });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
