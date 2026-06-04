import './globals.css'
import 'streamdown/styles.css'

export const metadata = {
  title: 'Aristo',
  icons: { icon: '/aristo-logo.png' },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
