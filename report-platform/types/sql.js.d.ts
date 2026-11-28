// sql.js 未自带类型声明，这里只声明本项目用到的部分。
declare module 'sql.js' {
  interface SqlJsConfig {
    wasmBinary?: Buffer | Uint8Array;
    locateFile?: (file: string) => string;
  }

  interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  interface Database {
    run(sql: string, params?: unknown[]): Database;
    prepare(sql: string): Statement;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
