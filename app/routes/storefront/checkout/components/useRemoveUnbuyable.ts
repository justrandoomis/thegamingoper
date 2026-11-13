import { useCallback, useEffect, useRef, useState } from "react";

import type { CartEditor } from "~/ui/cart-client";

/**
 * Takes lines that can no longer be bought (sold out, off sale) out of the cart through the page's cart editor
 * (client round 1, QA: a lost stock race). Unlike a removal by hand, no undo row stays behind — «تراجع» would only try
 * to add back what cannot be bought; the page's StockNotice says by name what was taken out. A removal the server
 * refuses comes back as the line with its sentence (the kit's rollback). `removing` while any is on its way.
 */
export function useRemoveUnbuyable(editor: CartEditor): { remove: (lineIds: readonly string[]) => void; removing: boolean; isRemoving: (lineId: string) => boolean } {
  const pending = useRef(new Set<string>());
  const [removing, setRemoving] = useState(false);
  const { rows, dismiss } = editor;

  useEffect(() => {
    if (pending.current.size === 0) return;
    for (const id of [...pending.current]) {
      const row = rows.find((candidate) => candidate.line.id === id);
      if (!row) pending.current.delete(id);
      else if (row.removed && !row.busy) {
        // settled: the line is gone on the server too — hide its undo row
        pending.current.delete(id);
        dismiss(id);
      } else if (!row.removed && row.error) pending.current.delete(id);
    }
    setRemoving(pending.current.size > 0);
  }, [rows, dismiss]);

  const remove = useCallback(
    (lineIds: readonly string[]) => {
      for (const id of lineIds) {
        if (pending.current.has(id)) continue;
        pending.current.add(id);
        editor.remove(id);
      }
      setRemoving(pending.current.size > 0);
    },
    [editor],
  );

  return { remove, removing, isRemoving: (lineId) => pending.current.has(lineId) };
}
