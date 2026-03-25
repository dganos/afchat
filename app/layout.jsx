import './globals.css'
import 'streamdown/styles.css'

export const metadata = {
  title: 'Document Assistant',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
