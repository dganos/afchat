'use client'

import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { useRef, useEffect } from 'react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputTextarea, PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { Tool } from '@/components/ai-elements/tool'
import { FileQuestion } from 'lucide-react'

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: 'http://localhost:3001/chat',
  })

  const isStreaming = status === 'streaming'
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center gap-2.5 px-4 py-3 border-b bg-background shadow-sm">
        <FileQuestion className="h-5 w-5 text-primary" />
        <span className="font-semibold text-foreground">Document Assistant</span>
        <span className="text-xs text-muted-foreground ml-auto">Powered by deepseek-r1:8b</span>
      </header>

      {/* Messages */}
      <Conversation className="flex-1">
        <ConversationContent>
          {/* Empty state */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-[60vh] text-muted-foreground gap-3">
              <FileQuestion className="h-12 w-12" />
              <p className="text-lg font-medium">Ask me anything about your documents</p>
              <p className="text-sm">I&apos;ll search and read them to find your answer</p>
            </div>
          )}

          {/* Message list */}
          {messages.map((msg) => (
            <Message key={msg.id} from={msg.role}>
              <MessageContent from={msg.role}>
                {msg.parts?.map((part, i) => {
                  if (part.type === 'tool-invocation') {
                    return (
                      <Tool
                        key={i}
                        toolName={part.toolInvocation.toolName}
                        state={part.toolInvocation.state}
                        result={part.toolInvocation.state === 'result' ? part.toolInvocation.result : null}
                      />
                    )
                  }

                  if (part.type === 'text') {
                    if (msg.role === 'user') {
                      return <span key={i}>{part.text}</span>
                    }
                    return (
                      <Streamdown
                        key={i}
                        plugins={{ code }}
                        isAnimating={isStreaming && msg === messages[messages.length - 1]}
                        animated
                      >
                        {part.text}
                      </Streamdown>
                    )
                  }

                  return null
                })}
              </MessageContent>
            </Message>
          ))}

          <div ref={bottomRef} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputTextarea
          value={input}
          onChange={handleInputChange}
          disabled={isStreaming}
        />
        <PromptInputSubmit
          isStreaming={isStreaming}
          disabled={isStreaming || !input.trim()}
        />
      </PromptInput>
    </div>
  )
}
