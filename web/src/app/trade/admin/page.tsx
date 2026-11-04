import { AdminCollateralTest } from "@/components/strategy/perps/AdminCollateralTest";

/**
 * Admin-only proving ground for the collateral path.
 *
 * The route is PUBLIC — Next has no server-side identity here and the nav
 * entry is merely hidden — so the gate that matters lives in the component,
 * which builds nothing unless the connected wallet is the admin address. Even
 * that is a guard against accident rather than a security boundary: the real
 * authority is the signature, and PEX accepts these groups from any wallet
 * willing to sign them.
 */
export const metadata = {
  title: "Admin · collateral test",
  robots: { index: false, follow: false },
};

export default function TradeAdminPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-xl font-semibold text-white">Collateral test</h1>
      <p className="mb-6 mt-1 text-[12px] text-gray-500">
        Opens and closes real positions on MainNet, away from the trading
        terminal. Used to prove a collateral path before it is offered to
        anyone.
      </p>
      <AdminCollateralTest />
    </main>
  );
}
