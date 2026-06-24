import * as React from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'

const ConversationContext = React.createContext({ isAtBottom: true, scrollToBottom: () => {} })

export function useConversation() {
  return React.useContext(ConversationContext)
}

export function Conversation({ children, className }) {
  const viewportRef = React.useRef(null)
  const [isAtBottom, setIsAtBottom] = React.useState(true)

  const scrollToBottom = React.useCallback(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const observer = new MutationObserver(() => {
      if (isAtBottom) {
        scrollToBottom()
      }
    })
    observer.observe(viewport, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [isAtBottom, scrollToBottom])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    function handleScroll() {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      setIsAtBottom(scrollHeight - scrollTop - clientHeight < 40)
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <ConversationContext.Provider value={{ isAtBottom, scrollToBottom }}>
      <ScrollArea className={cn('relative flex-1', className)}>
        <div ref={viewportRef} className="h-full overflow-y-auto">
          {children}
        </div>
      </ScrollArea>
    </ConversationContext.Provider>
  )
}

export function ConversationContent({ children, className }) {
  return (
    <div className={cn('mx-auto max-w-3xl px-4 py-4', className)}>
      {children}
    </div>
  )
}

export function ConversationScrollButton({ className }) {
  const { isAtBottom, scrollToBottom } = useConversation()

  if (isAtBottom) return null

  return (
    <button
      onClick={scrollToBottom}
      aria-label="גלול לתחתית"
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-surface text-fg border border-border shadow-md p-2 transition-colors hover:bg-surface-2',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  )
}
