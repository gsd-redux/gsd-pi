"use client"

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Check, CheckSquare, MessageSquare, Send, TextCursorInput, Type } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  type PendingUiRequest,
  useGSDWorkspaceActions,
  useGSDWorkspaceState,
} from "@/lib/gsd-workspace-store"
import { canCloudMutate } from "@/lib/cloud-client"
import { clampSelectIndex, getSingleSelectKeyAction } from "@/lib/select-keyboard"
import { cn } from "@/lib/utils"

function methodIcon(method: PendingUiRequest["method"]) {
  switch (method) {
    case "select":
      return <CheckSquare className="h-4 w-4" />
    case "confirm":
      return <MessageSquare className="h-4 w-4" />
    case "input":
      return <TextCursorInput className="h-4 w-4" />
    case "editor":
      return <Type className="h-4 w-4" />
  }
}

function methodLabel(method: PendingUiRequest["method"]): string {
  switch (method) {
    case "select":
      return "Selection"
    case "confirm":
      return "Confirmation"
    case "input":
      return "Input"
    case "editor":
      return "Editor"
  }
  return method
}

// --- Renderers for each blocking UI request type ---

function SelectRenderer({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "select" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const isMulti = Boolean(request.allowMultiple)
  const [singleIndex, setSingleIndex] = useState(() => clampSelectIndex(0, request.options.length))
  const [multiValues, setMultiValues] = useState<Set<string>>(() => new Set())
  const selectRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isMulti) {
      requestAnimationFrame(() => selectRef.current?.focus())
    }
  }, [isMulti])

  const handleSubmit = () => {
    if (isMulti) {
      onSubmit({ value: Array.from(multiValues) })
    } else {
      const option = request.options[singleIndex]
      if (option) onSubmit({ value: option })
    }
  }

  const submitSingleIndex = useCallback(
    (index: number) => {
      const option = request.options[index]
      if (!option || disabled) return
      setSingleIndex(index)
      onSubmit({ value: option })
    },
    [disabled, onSubmit, request.options],
  )

  const handleSingleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const action = getSingleSelectKeyAction(event.key, singleIndex, request.options.length)
      if (action.type === "none") return

      event.preventDefault()
      event.stopPropagation()

      if (action.type === "select") {
        setSingleIndex(action.index)
        return
      }

      submitSingleIndex(action.index)
    },
    [disabled, request.options.length, singleIndex, submitSingleIndex],
  )

  const canSubmit = isMulti ? multiValues.size > 0 : singleIndex >= 0

  if (isMulti) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          {request.options.map((option: string, index: number) => (
            <label
              key={`${option}-${index}`}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:bg-accent/40"
            >
              <Checkbox
                checked={multiValues.has(option)}
                onCheckedChange={(checked) => {
                  const next = new Set(multiValues)
                  if (checked) {
                    next.add(option)
                  } else {
                    next.delete(option)
                  }
                  setMultiValues(next)
                }}
                disabled={disabled}
              />
              <span className="text-sm">{option}</span>
            </label>
          ))}
        </div>
        <Button onClick={handleSubmit} disabled={disabled || !canSubmit} className="w-full">
          <Send className="h-4 w-4" />
          Submit selection ({multiValues.size})
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div
        ref={selectRef}
        role="listbox"
        tabIndex={0}
        aria-activedescendant={singleIndex >= 0 ? `focused-select-option-${singleIndex}` : undefined}
        onKeyDown={handleSingleKeyDown}
        className="space-y-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {request.options.map((option: string, index: number) => {
          const selected = index === singleIndex
          return (
            <button
              key={`${option}-${index}`}
              id={`focused-select-option-${index}`}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => submitSingleIndex(index)}
              disabled={disabled}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border hover:bg-accent/40",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="w-4 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">{option}</span>
              {selected && <Check className="h-4 w-4 shrink-0" />}
            </button>
          )
        })}
      </div>
      <Button onClick={handleSubmit} disabled={disabled || !canSubmit} className="w-full">
        <Send className="h-4 w-4" />
        Submit
      </Button>
    </div>
  )
}

function ConfirmRenderer({
  request,
  onSubmit,
  onCancel,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "confirm" }>
  onSubmit: (value: Record<string, unknown>) => void
  onCancel: () => void
  disabled: boolean
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-background px-4 py-3 text-sm leading-relaxed">
        {request.message}
      </div>
      <div className="flex gap-3">
        <Button onClick={() => onSubmit({ value: true })} disabled={disabled} className="flex-1">
          Confirm
        </Button>
        <Button onClick={onCancel} disabled={disabled} variant="outline" className="flex-1">
          Cancel
        </Button>
      </div>
    </div>
  )
}

function InputRenderer({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "input" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const [value, setValue] = useState("")

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onSubmit({ value })
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={request.placeholder || "Enter a value"}
        disabled={disabled}
        autoFocus
      />
      <Button type="submit" disabled={disabled || !value.trim()} className="w-full">
        <Send className="h-4 w-4" />
        Submit
      </Button>
    </form>
  )
}

function EditorRenderer({
  request,
  onSubmit,
  disabled,
}: {
  request: Extract<PendingUiRequest, { method: "editor" }>
  onSubmit: (value: Record<string, unknown>) => void
  disabled: boolean
}) {
  const [value, setValue] = useState(request.prefill || "")

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ value })
      }}
    >
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="min-h-[200px] font-mono text-sm"
        autoFocus
      />
      <Button type="submit" disabled={disabled} className="w-full">
        <Send className="h-4 w-4" />
        Submit
      </Button>
    </form>
  )
}

function RequestBody({
  request,
  onSubmit,
  onCancel,
  disabled,
}: {
  request: PendingUiRequest
  onSubmit: (value: Record<string, unknown>) => void
  onCancel: () => void
  disabled: boolean
}) {
  switch (request.method) {
    case "select":
      return <SelectRenderer request={request} onSubmit={onSubmit} disabled={disabled} />
    case "confirm":
      return <ConfirmRenderer request={request} onSubmit={onSubmit} onCancel={onCancel} disabled={disabled} />
    case "input":
      return <InputRenderer request={request} onSubmit={onSubmit} disabled={disabled} />
    case "editor":
      return <EditorRenderer request={request} onSubmit={onSubmit} disabled={disabled} />
  }
}

export function FocusedPanel() {
  const workspace = useGSDWorkspaceState()
  const { respondToUiRequest, dismissUiRequest } = useGSDWorkspaceActions()

  const pending = workspace.pendingUiRequests
  const isOpen = pending.length > 0
  const current = pending[0] ?? null
  const isSubmitting = workspace.commandInFlight === "extension_ui_response"

  // Cloud viewer role (ADR-047): approvals are read-only. Resolved
  // post-hydration; the panel content only renders when a request is open.
  const [cloudReadOnly, setCloudReadOnly] = useState(false)
  useEffect(() => {
    setCloudReadOnly(!canCloudMutate())
  }, [])
  const disabled = isSubmitting || cloudReadOnly

  const handleSubmit = (response: Record<string, unknown>) => {
    if (!current) return
    void respondToUiRequest(current.id, response)
  }

  const handleDismiss = () => {
    if (!current) return
    void dismissUiRequest(current.id)
  }

  // Prevent the Sheet from closing via overlay click / escape while submitting
  const handleOpenChange = (open: boolean) => {
    if (!open && !isSubmitting && current) {
      handleDismiss()
    }
  }

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex flex-col sm:max-w-md" data-testid="focused-panel">
        {current && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                {methodIcon(current.method)}
                <SheetTitle>{current.title || methodLabel(current.method)}</SheetTitle>
              </div>
              <SheetDescription>
                <span className="flex items-center gap-2">
                  <span>{methodLabel(current.method)} requested by the agent</span>
                  {pending.length > 1 && (
                    <span
                      className={cn(
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-semibold text-background",
                      )}
                      data-testid="focused-panel-queue-badge"
                    >
                      +{pending.length - 1}
                    </span>
                  )}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-4 py-2">
              {cloudReadOnly && (
                <p className="mb-2 text-xs text-muted-foreground">
                  Read-only viewer session — responses are disabled.
                </p>
              )}
              <RequestBody
                key={current.id}
                request={current}
                onSubmit={handleSubmit}
                onCancel={handleDismiss}
                disabled={disabled}
              />
            </div>

            <SheetFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDismiss}
                disabled={disabled}
                className="text-muted-foreground"
              >
                Dismiss
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
