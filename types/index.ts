export type ProductCategory = 'combo' | 'individual';

export interface Product {
  id: number;
  name: string;
  price: number;
  oldPrice?: number;
  tag?: string;
  cat: ProductCategory;
  img: string;
  desc: string;
  details: string;
}

export interface BoxType {
  id: string;
  name: string;
  price: number;
  img: string;
  desc: string;
  details: string;
  tag?: string;
}

export interface CustomCartItem extends Product {
  qty: number;
}

export interface TeamMember {
  name: string;
  role: string;
  desc: string;
  link?: string;
  img: string;
  fallbackInitials: string;
}

export interface OrderSubmission {
  type: 'order';
  name: string;
  phone: string;
  address: string;
  product: string;
  basePrice: number;
  deliveryCharge: number;
  deliveryArea: string;
  price: number;
  device?: string;
  location?: string;
}

export interface ContactSubmission {
  type: 'contact';
  name: string;
  phone: string;
  message: string;
  device?: string;
  location?: string;
}
