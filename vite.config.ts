import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages はリポジトリ名のサブパス（/slideshow-maker/）で配信される。
  // 相対パスで出力しておくと、サブパスでもローカルでもそのまま動く。
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
});
