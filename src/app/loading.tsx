import { getStoreSettings } from "@/server/services/admin-settings.service";
import Image from "next/image";
import { siteConfig } from "@/config/site";

export default async function Loading() {
  const [storeSettings] = await Promise.all([getStoreSettings()]);
  const logoUrl = storeSettings?.logoUrl;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#fbf7f4]/80 backdrop-blur-sm">
      {/* অ্যানিমেটেড স্পিনার বা গিফট বক্স থিমড লোডার */}
      <div className="relative flex items-center justify-center">
        {/* বাইরের রিং */}
        <div className="w-40 h-40 border-4 border-[#e8dad5] border-t-[#3a3f2b] rounded-full animate-spin"></div>

        {/* ভেতরের লোগো বা ডট */}
        <div className="absolute  animate-pulse">
          <Image
            src={logoUrl || "/images/logo.png"}
            alt={storeSettings?.storeName || siteConfig.name}
            width={120}
            height={120}
          />
        </div>
      </div>
    </div>
  );
}
