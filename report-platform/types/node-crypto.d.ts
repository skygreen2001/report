// 最小 node:crypto 类型垫片。
// 原因：本机 @types/node(22.20.5) 安装不完整，crypto.d.ts 缺失，导致 tsc 报
// "Cannot find module 'node:crypto'"。运行时 Node 自带该模块，真实可用。
// 这里只声明被本项目用到的 API，足够编译通过。
declare module "node:crypto" {
  import { Buffer } from "buffer";

  export interface Cipher {
    update(data: string | Buffer, inputEncoding?: BufferEncoding, outputEncoding?: BufferEncoding): Buffer;
    update(data: string | Buffer): Buffer;
    final(): Buffer;
    getAuthTag(): Buffer;
  }

  export interface Decipher {
    update(data: string | Buffer): Buffer;
    update(data: string | Buffer, inputEncoding?: BufferEncoding, outputEncoding?: BufferEncoding): Buffer;
    final(): Buffer;
    setAuthTag(tag: Buffer): void;
  }

  export interface Hash {
    update(data: string | Buffer): Hash;
    digest(encoding: BufferEncoding): string;
    digest(): Buffer;
  }

  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function createCipheriv(algorithm: string, key: Buffer | string, iv: Buffer | string): Cipher;
  export function createDecipheriv(algorithm: string, key: Buffer | string, iv: Buffer | string): Decipher;
  export function createHash(algorithm: string): Hash;

  const _default: {
    randomBytes: typeof randomBytes;
    randomUUID: typeof randomUUID;
    createCipheriv: typeof createCipheriv;
    createDecipheriv: typeof createDecipheriv;
    createHash: typeof createHash;
  };
  export default _default;
}
