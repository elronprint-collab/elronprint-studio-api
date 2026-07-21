import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
const DOMAIN = extra.SHOPIFY_DOMAIN || 'mxgb4q-em.myshopify.com';
const TOKEN = extra.SHOPIFY_STOREFRONT_TOKEN || '';
const API_VERSION = '2025-07';

export const isConfigured = () => TOKEN.length > 0;
export const CUSTOM_PRODUCT_QUERY = extra.CUSTOM_PRODUCT_QUERY || 'הדפסה על חולצות';

export type Product = {
  id: string;
  handle: string;
  title: string;
  image: string | null;
  price: string;
  currency: string;
};

export type Variant = {
  id: string;
  title: string;
  available: boolean;
  price: string;
  currency: string;
  options: { name: string; value: string }[];
};

export type ProductDetail = {
  id: string;
  handle: string;
  title: string;
  description: string;
  images: string[];
  variants: Variant[];
  optionNames: string[];
};

function money(amount: string, code: string) {
  return { price: Number(amount).toFixed(0), currency: code === 'ILS' ? '₪' : code };
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': TOKEN,
      'Accept-Language': 'he',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

const PRODUCT_CARD = `
  id handle title
  featuredImage { url }
  priceRange { minVariantPrice { amount currencyCode } }
`;

type CardNode = {
  id: string;
  handle: string;
  title: string;
  featuredImage: { url: string } | null;
  priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
};

function toCard(node: CardNode): Product {
  const m = money(node.priceRange.minVariantPrice.amount, node.priceRange.minVariantPrice.currencyCode);
  return { id: node.id, handle: node.handle, title: node.title, image: node.featuredImage?.url ?? null, ...m };
}

export async function fetchProducts(first = 20, search?: string): Promise<Product[]> {
  type Resp = { products: { edges: { node: CardNode }[] } };
  const data = await gql<Resp>(
    `query ($first: Int!, $query: String) {
      products(first: $first, sortKey: BEST_SELLING, query: $query) {
        edges { node { ${PRODUCT_CARD} } }
      }
    }`,
    { first, query: search ?? null },
  );
  return data.products.edges.map((e) => toCard(e.node));
}

export async function fetchProductByHandle(handle: string): Promise<ProductDetail | null> {
  type Resp = {
    product: {
      id: string;
      handle: string;
      title: string;
      description: string;
      options: { name: string }[];
      images: { edges: { node: { url: string } }[] };
      variants: {
        edges: {
          node: {
            id: string;
            title: string;
            availableForSale: boolean;
            price: { amount: string; currencyCode: string };
            selectedOptions: { name: string; value: string }[];
          };
        }[];
      };
    } | null;
  };
  const data = await gql<Resp>(
    `query ($handle: String!) {
      product(handle: $handle) {
        id handle title description
        options { name }
        images(first: 6) { edges { node { url } } }
        variants(first: 60) {
          edges { node {
            id title availableForSale
            price { amount currencyCode }
            selectedOptions { name value }
          } }
        }
      }
    }`,
    { handle },
  );
  if (!data.product) return null;
  const p = data.product;
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    images: p.images.edges.map((e) => e.node.url),
    optionNames: p.options.map((o) => o.name),
    variants: p.variants.edges.map((e) => ({
      id: e.node.id,
      title: e.node.title,
      available: e.node.availableForSale,
      options: e.node.selectedOptions,
      ...money(e.node.price.amount, e.node.price.currencyCode),
    })),
  };
}

// מציאת מוצר ההדפסה בהתאמה אישית עבור הסטודיו
export async function fetchCustomProduct(): Promise<ProductDetail | null> {
  type Resp = { products: { edges: { node: { handle: string } }[] } };
  const data = await gql<Resp>(
    `query ($q: String!) { products(first: 1, query: $q) { edges { node { handle } } } }`,
    { q: CUSTOM_PRODUCT_QUERY },
  );
  const handle = data.products.edges[0]?.node.handle;
  if (!handle) return null;
  return fetchProductByHandle(handle);
}

export type CartLineInput = {
  merchandiseId: string;
  quantity: number;
  attributes?: { key: string; value: string }[];
};

export async function createCheckout(lines: CartLineInput[]): Promise<string> {
  type Resp = {
    cartCreate: {
      cart: { checkoutUrl: string } | null;
      userErrors: { message: string }[];
    };
  };
  const data = await gql<Resp>(
    `mutation ($lines: [CartLineInput!]!) {
      cartCreate(input: { lines: $lines }) {
        cart { checkoutUrl }
        userErrors { message }
      }
    }`,
    { lines },
  );
  if (!data.cartCreate.cart) {
    throw new Error(data.cartCreate.userErrors[0]?.message || 'יצירת העגלה נכשלה');
  }
  return data.cartCreate.cart.checkoutUrl;
}
