export interface DnsRecord {
  RecordId: string;
  Domain: string;
  Name: string;
  Type: string;
  Value: string;
  Line: string;
  TTL: number;
  MX: number;
  Status: number;
  Proxiable?: boolean;
  Cloudflare?: {
    proxied?: boolean;
    proxiable?: boolean;
  };
  Weight?: number;
  Remark?: string;
  UpdateTime?: string;
}

export interface DomainInfo {
  Domain: string;
  ThirdId: string;
  RecordCount?: number;
  ExpiresAt?: string;  // 域名到期时间（ISO 8601 格式）
  AdapterData?: any;   // 适配器自定义数据，同步时存入 adapter_data 列
}

export interface PageResult<T> {
  total: number;
  list: T[];
}

export interface DnsAdapter {
  check(): Promise<boolean>;
  getError(): string;
  /** 可选：清空上一次错误（读接口用它做 fail-closed 判定） */
  clearError?(): void;
  getDomainList(keyword?: string, page?: number, pageSize?: number): Promise<PageResult<DomainInfo>>;
  getDomainRecords(
    page?: number,
    pageSize?: number,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>>;
  getDomainRecordInfo(recordId: string): Promise<DnsRecord | null>;
  addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<string | null>;
  updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<boolean>;
  deleteDomainRecord(recordId: string): Promise<boolean>;
  setDomainRecordStatus(recordId: string, status: number): Promise<boolean>;
  getRecordLines(): Promise<Array<{ id: string; name?: string }>>;
  getMinTTL(): Promise<number>;
  addDomain(domain: string): Promise<boolean>;
}
