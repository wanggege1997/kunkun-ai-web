declare module "ali-oss" {
  type OssHeaders = Record<string, string | number | undefined>;

  type OssClientOptions = {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    endpoint?: string;
    secure?: boolean;
    timeout?: string | number;
  };

  type PutOptions = {
    headers?: OssHeaders;
  };

  type GetResult = {
    content: Buffer | ArrayBuffer | Uint8Array | string;
    res?: {
      headers?: Record<string, string | string[] | undefined>;
    };
  };

  export default class OSS {
    constructor(options: OssClientOptions);
    put(name: string, file: Buffer | ArrayBuffer | Uint8Array | string, options?: PutOptions): Promise<unknown>;
    get(name: string): Promise<GetResult>;
    delete(name: string): Promise<unknown>;
  }
}
