import React from 'react'
import { FileText } from 'lucide-react'

export function isImageIcon(icon) {
  if (!icon || typeof icon !== 'string') return false
  return (
    icon.startsWith('data:image') ||
    icon.startsWith('http://') ||
    icon.startsWith('https://') ||
    icon.startsWith('blob:')
  )
}

export default function PageIcon({ icon, size = 16, className = '', defaultIcon = null }) {
  if (!icon) {
    return defaultIcon || <FileText size={size} className={className} aria-hidden="true" />
  }

  if (isImageIcon(icon)) {
    return (
      <img
        src={icon}
        alt=""
        className={`page-icon-image ${className}`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          objectFit: 'cover',
          borderRadius: '3px',
          display: 'inline-block',
          verticalAlign: 'middle',
          flexShrink: 0
        }}
        aria-hidden="true"
      />
    )
  }

  return (
    <span
      className={`page-icon-text ${className}`}
      style={{
        fontSize: `${size}px`,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}
