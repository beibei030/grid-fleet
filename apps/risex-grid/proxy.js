// 仅 risex-grid 进程内生效：读 RISEX_PROXY，不改系统代理。
export async function setupProxy() {
  const proxy = process.env.RISEX_PROXY?.trim();
  if (!proxy) return null;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    return proxy;
  } catch (e) {
    console.error('⚠ 已配置代理 ' + proxy + ' 但未能加载 undici，请先运行 npm install。错误：' + e.message);
    return null;
  }
}
