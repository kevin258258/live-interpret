export async function readEvents(response, onEvent) {
  if (!response.ok)
    throw new Error(`工作台连接失败（HTTP ${response.status}）`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        for (const line of block.split("\n"))
          if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
      }
      if (pending.length > 1000000) throw new Error("字幕连接返回了过大的消息");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
