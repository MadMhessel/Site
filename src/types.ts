export type View = 'home' | 'catalog' | 'cart';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  unit: string;
  category: string;
}

export interface CatalogState {
  products: Product[];
  categories: string[];
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface CartState {
  items: CartItem[];
}

export interface FilterCriteria {
  query: string;
  category: string | null;
  priceMin: number | null;
  priceMax: number | null;
}

export interface Snapshot {
  timestamp: number;
  catalog: CatalogState;
  content: Record<string, string>;
}

export interface ToastMessage {
  message: string;
  type: 'info' | 'success' | 'error';
}
