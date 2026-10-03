declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    /** JPEG only, 0..1 */
    quality?: number;
  }
  function convert(opts: ConvertOptions): Promise<ArrayBuffer | Buffer>;
  export default convert;
}
