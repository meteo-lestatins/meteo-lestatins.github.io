export async function mapPool(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        failure ||= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}
