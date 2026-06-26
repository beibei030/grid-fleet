// 仅 extended-grid 进程内生效：只读 EXTENDED_PROXY，不改系统代理、不影响对冲。
import net from 'node:net';

async function proxyReachable(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return await new Promise((resolve) => {
      const s = net.connect({ host: u.hostname, port, timeout: 2500 });
      const done = (ok) => {
        try { s.destroy(); } catch { /* ignore */ }
        resolve(ok);
      };
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
      s.setTimeout(2500, () => done(false));
    });
  } catch {
    return false;
  }
}

export async function setupProxy() {
  const proxy = process.env.EXTENDED_PROXY?.trim();
  if (!proxy) return null;
  let reachable = false;
  for (let i = 0; i < 8; i++) {
    if (await proxyReachable(proxy)) {
      reachable = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!reachable) {
    throw new Error('[代理] ' + proxy + ' 不可达。请先运行 deploy\\vps-extended-proxy\\start-ext-singbox-proxy.bat');
  }
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    return proxy;
  } catch (e) {
    console.error('⚠ 已配置代理 ' + proxy + ' 但未能加载 undici，请先运行 npm install。错误：' + e.message);
    return null;
  }
}

/** 运行中代理失效时切回直连（避免 balance/equity 一直停在旧值） */
export async function disableProxyToDirect() {
  try {
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new Agent());
    return true;
  } catch {
    return false;
  }
}
