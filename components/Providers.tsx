'use client';

import React from 'react';
import { CartProvider, useCart } from '@/context/CartContext';
import OrderModal from '@/components/OrderModal';
import { Sparkles } from 'lucide-react';

function GlobalModalAndToast() {
  const {
    orderModalItem,
    isOrderModalOpen,
    closeOrderModal,
    clearCustomCart,
    toastMessage,
  } = useCart();

  return (
    <>
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-[#3a3f2b] text-white text-xs sm:text-sm font-semibold shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-bottom-5">
          <Sparkles className="w-4 h-4 text-[#3a3f2b]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Global Checkout Modal */}
      <OrderModal
        isOpen={isOrderModalOpen}
        onClose={closeOrderModal}
        orderItem={orderModalItem}
        onOrderSuccess={() => {
          if (orderModalItem?.isCustom) {
            clearCustomCart();
          }
        }}
      />
    </>
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider>
      {children}
      <GlobalModalAndToast />
    </CartProvider>
  );
}
