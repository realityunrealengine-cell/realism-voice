import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Edge Function (Deno) импортирует npm:-пакет — в тестах подменяется заглушкой
      'npm:@supabase/supabase-js@2': path.resolve(__dirname, 'tests/helpers/supabaseEdgeStub.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
