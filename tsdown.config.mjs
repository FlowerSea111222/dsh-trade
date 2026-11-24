/** host 半（无行为，占位；交易数据面由 @dshtrading/bot-api 提供）。 */
export default {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: false,
  sourcemap: false,
  entryFileNames: 'index.js',
}
