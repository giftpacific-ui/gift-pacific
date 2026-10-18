'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Product, BoxType, CustomCartItem } from '@/types';

export interface OrderModalItem {
  name: string;
  basePrice: number;
  isCustom?: boolean;
}

interface CartContextType {
  selectedBox: BoxType | null;
  customCart: CustomCartItem[];
  selectBox: (box: BoxType | null) => void;
  addToCustomCart: (product: Product) => void;
  updateCustomCartQty: (productId: number, delta: number) => void;
  removeFromCustomCart: (productId: number) => void;
  clearCustomCart: () => void;
  totalCustomCartItems: number;
  totalCustomPrice: number;
  // Order modal state
  orderModalItem: OrderModalItem | null;
  isOrderModalOpen: boolean;
  openOrderModal: (item: OrderModalItem) => void;
  closeOrderModal: () => void;
  // Toast notifications
  toastMessage: string | null;
  showToast: (msg: string) => void;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [selectedBox, setSelectedBox] = useState<BoxType | null>(null);
  const [customCart, setCustomCart] = useState<CustomCartItem[]>([]);
  const [orderModalItem, setOrderModalItem] = useState<OrderModalItem | null>(null);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  // Restore cart & box from localStorage after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const savedBox = localStorage.getItem('mtc_selected_box');
        if (savedBox) setSelectedBox(JSON.parse(savedBox));

        const savedCart = localStorage.getItem('mtc_custom_cart');
        if (savedCart) setCustomCart(JSON.parse(savedCart));
      } catch {
        // Ignore storage errors
      } finally {
        setIsHydrated(true);
      }
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  // Save to localStorage when state changes after initial hydration
  useEffect(() => {
    if (!isHydrated) return;
    try {
      if (selectedBox) {
        localStorage.setItem('mtc_selected_box', JSON.stringify(selectedBox));
      } else {
        localStorage.removeItem('mtc_selected_box');
      }
    } catch {
      // Ignore storage errors
    }
  }, [selectedBox, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem('mtc_custom_cart', JSON.stringify(customCart));
    } catch {
      // Ignore storage errors
    }
  }, [customCart, isHydrated]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  const selectBox = (box: BoxType | null) => {
    setSelectedBox(box);
    if (box) {
      showToast(`✓ ${box.name} সিলেক্ট করা হয়েছে`);
    }
  };

  const addToCustomCart = (product: Product) => {
    setCustomCart((prev) => {
      const exists = prev.find((item) => item.id === product.id);
      if (exists) {
        return prev.map((item) =>
          item.id === product.id ? { ...item, qty: item.qty + 1 } : item
        );
      }
      return [...prev, { ...product, qty: 1 }];
    });
    showToast(`✓ ${product.name} কম্বোতে যোগ করা হয়েছে!`);
  };

  const updateCustomCartQty = (productId: number, delta: number) => {
    setCustomCart((prev) => {
      return prev
        .map((item) => {
          if (item.id === productId) {
            const newQty = item.qty + delta;
            return newQty > 0 ? { ...item, qty: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CustomCartItem[];
    });
  };

  const removeFromCustomCart = (productId: number) => {
    setCustomCart((prev) => prev.filter((item) => item.id !== productId));
    showToast('আইটেমটি সরানো হয়েছে');
  };

  const clearCustomCart = () => {
    setCustomCart([]);
    setSelectedBox(null);
    try {
      localStorage.removeItem('mtc_selected_box');
      localStorage.removeItem('mtc_custom_cart');
    } catch {
      // Ignore storage errors
    }
  };

  const openOrderModal = (item: OrderModalItem) => {
    setOrderModalItem(item);
    setIsOrderModalOpen(true);
  };

  const closeOrderModal = () => {
    setIsOrderModalOpen(false);
  };

  const totalCustomCartItems = customCart.reduce((sum, item) => sum + item.qty, 0);
  const totalCustomPrice =
    (selectedBox ? selectedBox.price : 0) +
    customCart.reduce((sum, item) => sum + item.price * item.qty, 0);

  return (
    <CartContext.Provider
      value={{
        selectedBox,
        customCart,
        selectBox,
        addToCustomCart,
        updateCustomCartQty,
        removeFromCustomCart,
        clearCustomCart,
        totalCustomCartItems,
        totalCustomPrice,
        orderModalItem,
        isOrderModalOpen,
        openOrderModal,
        closeOrderModal,
        toastMessage,
        showToast,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
