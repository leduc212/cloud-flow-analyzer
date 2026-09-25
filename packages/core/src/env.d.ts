// `URL` exists in every runtime this package targets (browsers and Node 22), but the ES
// library doesn't declare it and this package deliberately doesn't load the DOM types.
declare class URL {
  constructor(url: string, base?: string);
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly origin: string;
  readonly pathname: string;
  readonly searchParams: Iterable<[string, string]>;
}
