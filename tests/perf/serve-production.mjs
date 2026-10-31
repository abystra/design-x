// Local measurement-only preview. No application source/configuration is changed.
import { preview } from 'vite';
import { resolve } from 'node:path';
const outDir = resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 5175);
const apiOrigin = process.env.DESIGNX_PERF_API_ORIGIN || 'http://127.0.0.1:3001';
const expectedOrigin = process.env.DESIGNX_PERF_WEB_ORIGIN || 'http://127.0.0.1:5173';
const server = await preview({
  configFile: false,
  build: { outDir },
  preview: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': { target: apiOrigin, changeOrigin: false,
      configure(proxy) { proxy.on('proxyReq', req => req.setHeader('Origin', expectedOrigin)); },
    } },
  },
});
server.printUrls();
console.log(`PERF preview ${outDir}; API ${apiOrigin}; local proxy Origin ${expectedOrigin}`);

