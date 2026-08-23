import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { loadAvatarAsset } from './avatar-assets'
import { motionForEmotion, type Emotion } from './personality'
import type { PetProfile } from './profile'

function BuiltinPet({ emotion, intensity, speaking, name }: { emotion: Emotion; intensity: number; speaking: boolean; name: string }) {
  return <div className={`pet pet-${emotion}${speaking ? ' is-speaking' : ''}`} style={{ '--intensity': intensity } as CSSProperties} aria-label={`桌宠状态：${emotion}`}>
    <div className="sparkles" aria-hidden><i /><i /><i /></div>
    <div className="ear ear-left" /><div className="ear ear-right" />
    <div className="face"><div className="eye eye-left" /><div className="eye eye-right" /><div className="blush blush-left" /><div className="blush blush-right" /><div className="mouth" /></div>
    <div className="body"><span className="badge">{name.slice(0, 6)}</span></div>
  </div>
}

function AutoRigAvatar({ src, emotion, speaking, name }: { src: string; emotion: Emotion; speaking: boolean; name: string }) {
  return <div className={`auto-rig emotion-${emotion}${speaking ? ' is-speaking' : ''}`} aria-label={`${name}的动态图片角色`}>
    <div className="auto-rig-shadow" />
    <img className="auto-rig-body" src={src} alt="" />
    <div className="auto-rig-head"><img src={src} alt={`${name}的动态角色`} /></div>
    <div className="auto-rig-mouth"><img src={src} alt="" /></div>
    <div className="auto-rig-light" aria-hidden />
  </div>
}

function Live2DStage({ emotion, modelUrl }: { emotion: Emotion; modelUrl: string }) {
  const host = useRef<HTMLDivElement>(null)
  const model = useRef<any>(null)
  useEffect(() => {
    if (!modelUrl || !host.current) return
    let app: any; let alive = true
    void (async () => {
      const PIXI: any = await import('pixi.js')
      ;(window as any).PIXI = PIXI
      const { Live2DModel }: any = await import('pixi-live2d-display/cubism4')
      app = new PIXI.Application({ width: 200, height: 220, transparent: true, antialias: true })
      host.current?.appendChild(app.view)
      const loaded = await Live2DModel.from(modelUrl)
      if (!alive) return
      loaded.anchor?.set?.(0.5, 1); loaded.x = 100; loaded.y = 215; loaded.scale.set(0.23)
      app.stage.addChild(loaded); model.current = loaded
    })().catch((error) => console.warn('[dsh-pet] Live2D model fallback:', error))
    return () => { alive = false; model.current?.destroy?.(); app?.destroy?.(true, { children: true }) }
  }, [modelUrl])
  useEffect(() => { model.current?.motion?.(motionForEmotion(emotion), 2) }, [emotion])
  return <div className="live2d" ref={host} />
}

function expressionFor(emotion: Emotion) {
  if (emotion === 'happy') return 'happy'
  if (emotion === 'gentle') return 'relaxed'
  if (emotion === 'concerned' || emotion === 'error') return 'sad'
  if (emotion === 'listening') return 'surprised'
  return 'neutral'
}

function ThreeAvatar({ src, emotion, speaking }: { src: string; emotion: Emotion; speaking: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const state = useRef({ emotion, speaking })
  state.current = { emotion, speaking }
  useEffect(() => {
    if (!host.current || !src) return
    const element = host.current
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
    camera.position.set(0, 1.25, 3.2)
    scene.add(new THREE.HemisphereLight(0xfff5ff, 0x59386d, 2.4))
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 3); scene.add(key)
    const root = new THREE.Group(); scene.add(root)
    let vrm: VRM | undefined
    let alive = true
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.load(src, (gltf) => {
      if (!alive) return
      vrm = gltf.userData.vrm as VRM | undefined
      if (vrm) { VRMUtils.removeUnnecessaryVertices(vrm.scene); VRMUtils.rotateVRM0(vrm) }
      const model = vrm?.scene ?? gltf.scene
      root.add(model)
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      model.position.sub(center)
      const scale = 1.9 / Math.max(size.y, 0.01)
      model.scale.setScalar(scale)
      model.position.y += size.y * scale * 0.5 - 0.92
    }, undefined, (error) => console.warn('[dsh-pet] 3D avatar load failed', error))
    const resize = () => {
      const width = Math.max(element.clientWidth, 1); const height = Math.max(element.clientHeight, 1)
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize); observer.observe(element); resize()
    const clock = new THREE.Clock(); let frame = 0
    const render = () => {
      frame = requestAnimationFrame(render)
      const delta = clock.getDelta(); const elapsed = clock.elapsedTime
      const active = state.current
      root.position.y = Math.sin(elapsed * (active.emotion === 'happy' ? 4 : 2)) * (active.emotion === 'happy' ? 0.055 : 0.02)
      root.rotation.y = Math.sin(elapsed * 0.75) * 0.08
      if (vrm) {
        vrm.update(delta)
        const manager = vrm.expressionManager
        for (const name of ['happy', 'relaxed', 'sad', 'surprised']) manager?.setValue(name, name === expressionFor(active.emotion) ? 0.72 : 0)
        manager?.setValue('aa', active.speaking ? 0.18 + Math.abs(Math.sin(elapsed * 11)) * 0.58 : 0)
        const head = vrm.humanoid?.getNormalizedBoneNode('head')
        if (head) { head.rotation.z = Math.sin(elapsed * 1.1) * 0.035; head.rotation.x = Math.sin(elapsed * 0.8) * 0.025 }
      }
      renderer.render(scene, camera)
    }
    render()
    return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); renderer.dispose(); renderer.domElement.remove() }
  }, [src])
  return <div className="three-avatar" ref={host} />
}

export function AvatarStage({ profile, emotion, intensity, speaking }: { profile: PetProfile; emotion: Emotion; intensity: number; speaking: boolean }) {
  const [assetUrl, setAssetUrl] = useState('')
  useEffect(() => {
    let currentUrl = ''
    if (!profile.avatarAssetId) { setAssetUrl(profile.skinDataUrl || ''); return }
    void loadAvatarAsset(profile.avatarAssetId).then((blob) => {
      if (!blob) return
      currentUrl = URL.createObjectURL(blob); setAssetUrl(currentUrl)
    })
    return () => { if (currentUrl) URL.revokeObjectURL(currentUrl) }
  }, [profile.avatarAssetId, profile.skinDataUrl])
  const name = profile.name || '小深'
  if (profile.avatarMode === 'model3d' && assetUrl) return <ThreeAvatar src={assetUrl} emotion={emotion} speaking={speaking} />
  if (profile.avatarMode === 'live2d' && profile.live2dModelUrl) return <Live2DStage emotion={emotion} modelUrl={profile.live2dModelUrl} />
  if ((profile.avatarMode === 'image' || profile.skinDataUrl) && assetUrl) return <AutoRigAvatar src={assetUrl} emotion={emotion} speaking={speaking} name={name} />
  return <BuiltinPet emotion={emotion} intensity={intensity} speaking={speaking} name={name} />
}
