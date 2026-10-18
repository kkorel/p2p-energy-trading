'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { MessageCircle } from 'lucide-react';
import { ChatOverlay } from './chat-overlay';

export function ChatBubble() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  // Hide on home page — home page has its own full-screen chat
  if (pathname === '/') return null;

  if (isOpen) {
    return <ChatOverlay onClose={() => setIsOpen(false)} />;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none">
      <div className="w-full max-w-[480px] relative">
        <button
          onClick={() => setIsOpen(true)}
          className="pointer-events-auto absolute right-4 bottom-28 w-14 h-14 rounded-full bg-teal-600 text-white shadow-lg flex items-center justify-center hover:bg-teal-700 hover:scale-105 active:scale-95 transition-all"
          aria-label="Chat with Oorja"
        >
          <MessageCircle size={26} />
        </button>
      </div>
    </div>
  );
}
