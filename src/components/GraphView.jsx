import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useStore } from '../store/useStore'
import { extractLinksFromPages } from '../utils/linkParser'
import ForceGraph2D from 'react-force-graph-2d'
import { useRef, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import './GraphView.css'

export default function GraphView({ onClose }) {
  const pages = useLiveQuery(() => db.pages.toArray())
  const { setActivePageId } = useStore()
  const fgRef = useRef()
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const containerRef = useRef(null)

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        })
      }
    }
    
    window.addEventListener('resize', handleResize)
    handleResize() 
    
    setTimeout(handleResize, 100)
    
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const graphData = pages ? extractLinksFromPages(pages) : { nodes: [], edges: [] }

  const handleNodeClick = (node) => {
    setActivePageId(node.id)
    if (onClose) onClose()
  }

  const paintNode = (node, ctx, globalScale) => {
    const label = node.emoji ? `${node.emoji} ${node.name}` : node.name
    const fontSize = 12 / globalScale
    ctx.font = `${fontSize}px Sans-Serif`
    const textWidth = ctx.measureText(label).width
    const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2)

    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#333'
    ctx.fillText(label, node.x, node.y)

    node.__bckgDimensions = bckgDimensions 
  }

  const nodePointerAreaPaint = (node, color, ctx) => {
    ctx.fillStyle = color
    const bckgDimensions = node.__bckgDimensions
    bckgDimensions && ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, ...bckgDimensions)
  }

  return (
    <div className="graph-view-container" ref={containerRef}>
      <div className="graph-header">
        <h2>Graph View</h2>
        <button className="icon-btn" onClick={onClose}><X size={20}/></button>
      </div>
      <div className="graph-body">
        {pages && (
          <ForceGraph2D
            ref={fgRef}
            width={dimensions.width}
            height={dimensions.height}
            graphData={graphData}
            nodeLabel="name"
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={nodePointerAreaPaint}
            onNodeClick={handleNodeClick}
            linkColor={() => '#ccc'}
            linkWidth={1.5}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            d3VelocityDecay={0.3}
          />
        )}
      </div>
    </div>
  )
}
