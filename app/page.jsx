'use client'

import { useChat } from '@ai-sdk/react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { useRef, useEffect, useState } from 'react'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputTextarea, PromptInputSubmit } from '@/components/ai-elements/prompt-input'
import { Tool } from '@/components/ai-elements/tool'
import { FolderOpen, Settings2 } from 'lucide-react'
import { HelicopterLoader } from '@/components/helicopter-loader'
import { LogsPanel } from '@/components/logs-panel'
import { DocumentsPanel } from '@/components/documents-panel'
import { ModelSelector } from '@/components/model-selector'
import { MemoryMeter } from '@/components/memory-meter'
import { SettingsPanel } from '@/components/settings-panel'

const DEFAULT_SETTINGS = { autoSearch: false }

function loadSettings() {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const saved = localStorage.getItem('docassist-settings')
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS
  } catch { return DEFAULT_SETTINGS }
}

export default function ChatPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    setSettings(loadSettings())
  }, [])

  const saveSettings = (next) => {
    setSettings(next)
    localStorage.setItem('docassist-settings', JSON.stringify(next))
  }

  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: 'http://localhost:3001/chat',
    body: { autoSearch: settings.autoSearch },
  })

  const [docsOpen, setDocsOpen] = useState(false)
  const isStreaming = status === 'streaming'
  const isWaiting = status === 'submitted'
  const isBusy = isStreaming || isWaiting
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center gap-2.5 px-4 py-0 bg-background">
        <img src="./aristo-logo.png" alt="Aristo" className="h-28 w-auto select-none" draggable="false" />
        <div className="ml-auto flex items-center gap-1">
          <MemoryMeter />
          <ModelSelector />
          <button
            onClick={() => setDocsOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground rounded-md hover:bg-muted transition-colors"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Documents
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground rounded-md hover:bg-muted transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Messages */}
      <Conversation className="flex-1">
        <ConversationContent>
          {/* Empty state */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
              <img
                src="./aristo-logo.png"
                alt="Aristo"
                className="h-80 w-auto select-none drop-shadow-[0_0_70px_rgba(59,130,246,0.45)]"
                draggable="false"
              />
              <p className="text-lg font-medium text-foreground">Ask me anything about your documents</p>
              <p className="text-sm text-muted-foreground">I&apos;ll search and read them to find your answer</p>
            </div>
          )}

          {/* Message list */}
          {messages.map((msg) => (
            <Message key={msg.id} from={msg.role} isThinking={isBusy && msg.role === 'assistant' && msg === messages[messages.length - 1]}>
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

          {/* Thinking indicator — shown while waiting for response */}
          {isWaiting && (
            <div className="flex gap-3 mb-6">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <HelicopterLoader className="h-5 w-5" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputTextarea
          value={input}
          onChange={handleInputChange}
          disabled={isBusy}
        />
        <PromptInputSubmit
          isStreaming={isBusy}
          disabled={isBusy || !input.trim()}
        />
      </PromptInput>

      <LogsPanel />
      <DocumentsPanel open={docsOpen} onClose={() => setDocsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSettingsChange={saveSettings} />
    </div>
  )
}
