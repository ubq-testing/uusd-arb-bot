export interface PoolAttributes {
  name: string;
  address: string;
  base_token_price_usd: string | null;
  quote_token_price_usd: string | null;
  base_token_price_native_currency: string | null;
  reserve_in_usd: string | null;
  pool_created_at: string | null;
  fdv_usd: string | null;
  market_cap_usd: string | null;
  price_change_percentage: {
    h1: string | null;
    h24: string | null;
  };
  volume_usd: {
    h1: string | null;
    h24: string | null;
  };
}

export interface Pool {
  id: string;
  type: "pool";
  attributes: PoolAttributes;
  relationships?: {
    base_token?: { data: { id: string; type: "token" } };
    quote_token?: { data: { id: string; type: "token" } };
    dex?: { data: { id: string; type: "dex" } };
  };
}

export interface TokenAttributes {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image_url: string | null;
  coingecko_coin_id: string | null;
  price_usd: string | null;
  total_reserve_in_usd: string | null;
  volume_usd: {
    h24: string | null;
  };
}

export interface Token {
  id: string;
  type: "token";
  attributes: TokenAttributes;
}

export interface PoolWithIncluded {
  data: Pool;
  included?: (Token | { id: string; type: "dex"; attributes: { name: string } })[];
}

export interface OhlcvData {
  id: string;
  type: "ohlcv";
  attributes: {
    ohlcv_list: [number, number, number, number, number, number][]; // [timestamp, open, high, low, close, volume]
  };
}

export interface OhlcvResponse {
  data: OhlcvData;
}
