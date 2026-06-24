import './globals.css'
import 'streamdown/styles.css'

export const metadata = {
  title: 'Aristo',
  icons: { icon: '/logo.svg' },
}

// Set the theme synchronously, before first paint, to avoid a flash of the
// wrong theme. Resolution order: explicit stored choice → system preference →
// light fallback.
const themeScript = `(function(){try{var t=localStorage.getItem('aristo-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`

export default function RootLayout({ children }) {
  return (
    <html lang="he" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
