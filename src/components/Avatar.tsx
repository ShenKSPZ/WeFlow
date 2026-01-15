import React, { useState, useEffect, useRef, useMemo } from 'react'
import { User } from 'lucide-react'
import { avatarLoadQueue } from '../utils/AvatarLoadQueue'
import './Avatar.scss'

// 全局缓存已成功加载过的头像 URL，用于控制后续是否显示动画
const loadedAvatarCache = new Set<string>()

interface AvatarProps {
    src?: string
    name?: string
    size?: number | string
    shape?: 'circle' | 'square' | 'rounded'
    className?: string
    lazy?: boolean
    onClick?: () => void
}

export const Avatar = React.memo(function Avatar({
    src,
    name,
    size = 48,
    shape = 'rounded',
    className = '',
    lazy = true,
    onClick
}: AvatarProps) {
    // 如果 URL 已在缓存中，则直接标记为已加载，不显示骨架屏和淡入动画
    const isCached = useMemo(() => src ? loadedAvatarCache.has(src) : false, [src])
    const [imageLoaded, setImageLoaded] = useState(isCached)
    const [imageError, setImageError] = useState(false)
    const [shouldLoad, setShouldLoad] = useState(!lazy || isCached)
    const [isInQueue, setIsInQueue] = useState(false)
    const imgRef = useRef<HTMLImageElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const getAvatarLetter = (): string => {
        if (!name) return '?'
        const chars = [...name]
        return chars[0] || '?'
    }

    // Intersection Observer for lazy loading
    useEffect(() => {
        if (!lazy || shouldLoad || isInQueue || !src || !containerRef.current || isCached) return

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !isInQueue) {
                        setIsInQueue(true)
                        avatarLoadQueue.enqueue(src).then(() => {
                            setShouldLoad(true)
                        }).catch(() => {
                            // 加载失败不要立刻显示错误，让浏览器渲染去报错
                            setShouldLoad(true)
                        }).finally(() => {
                            setIsInQueue(false)
                        })
                        observer.disconnect()
                    }
                })
            },
            { rootMargin: '100px' }
        )

        observer.observe(containerRef.current)

        return () => observer.disconnect()
    }, [src, lazy, shouldLoad, isInQueue, isCached])

    // Reset state when src changes
    useEffect(() => {
        const cached = src ? loadedAvatarCache.has(src) : false
        setImageLoaded(cached)
        setImageError(false)
        if (lazy && !cached) {
            setShouldLoad(false)
            setIsInQueue(false)
        } else {
            setShouldLoad(true)
        }
    }, [src, lazy])

    // Check if image is already cached/loaded
    useEffect(() => {
        if (shouldLoad && imgRef.current?.complete && imgRef.current?.naturalWidth > 0) {
            setImageLoaded(true)
        }
    }, [src, shouldLoad])

    const style = {
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
    }

    const hasValidUrl = !!src && !imageError && shouldLoad

    return (
        <div
            ref={containerRef}
            className={`avatar-component ${shape} ${className}`}
            style={style}
            onClick={onClick}
        >
            {hasValidUrl ? (
                <>
                    {!imageLoaded && <div className="avatar-skeleton" />}
                    <img
                        ref={imgRef}
                        src={src}
                        alt={name || 'avatar'}
                        className={`avatar-image ${imageLoaded ? 'loaded' : ''} ${isCached ? 'instant' : ''}`}
                        onLoad={() => {
                            if (src) loadedAvatarCache.add(src)
                            setImageLoaded(true)
                        }}
                        onError={() => setImageError(true)}
                        loading={lazy ? "lazy" : "eager"}
                    />
                </>
            ) : (
                <div className="avatar-placeholder">
                    {name ? <span className="avatar-letter">{getAvatarLetter()}</span> : <User size="50%" />}
                </div>
            )}
        </div>
    )
})
