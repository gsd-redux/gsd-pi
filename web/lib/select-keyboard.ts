export type SingleSelectKeyAction =
  | { type: "none" }
  | { type: "select"; index: number }
  | { type: "submit"; index: number }

export function clampSelectIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) return -1
  return Math.max(0, Math.min(optionCount - 1, index))
}

export function numberKeyToSelectIndex(key: string, optionCount: number): number | null {
  if (!/^[1-9]$/.test(key)) return null
  const index = Number(key) - 1
  return index < optionCount ? index : null
}

export function getSingleSelectKeyAction(
  key: string,
  currentIndex: number,
  optionCount: number,
): SingleSelectKeyAction {
  if (optionCount <= 0) return { type: "none" }

  const numberIndex = numberKeyToSelectIndex(key, optionCount)
  if (numberIndex !== null) return { type: "select", index: numberIndex }

  if (key === "ArrowUp") {
    return { type: "select", index: clampSelectIndex(currentIndex - 1, optionCount) }
  }
  if (key === "ArrowDown") {
    return { type: "select", index: clampSelectIndex(currentIndex + 1, optionCount) }
  }
  if (key === "Home") {
    return { type: "select", index: 0 }
  }
  if (key === "End") {
    return { type: "select", index: optionCount - 1 }
  }
  if (key === "Enter" || key === " ") {
    return { type: "submit", index: clampSelectIndex(currentIndex, optionCount) }
  }

  return { type: "none" }
}
