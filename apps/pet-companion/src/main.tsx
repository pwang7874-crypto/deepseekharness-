import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { defaultProfile, loadProfile, ProfilePanel, type PetProfile } from './profile'
import { motionForEmotion, shouldKeepCurrentBubble, speechTuning, type Emotion } from './personality'
import type { PetEvent } from './types'
import './styles.css'

const bridgeUrl = import.meta.env.VITE_DSH_PET_BRIDGE ?? 'http://127.0.0.1:3080/dsh-pet/events'
const fallbackBridgeToken = import.meta.env.VITE_DSH_PET_TOKEN ?? 'change-me-before-production'

type BootstrapState = 'checking' | 'ready' | 'missing-dsh' | 'restart-required' | 'failed'
type BootstrapReport = { state: BootstrapState; message: string; dshPath?: string; detail?: string }

function speak(text: string, emotion: Emotion, intensity: number, profile: PetProfile) {
  if (!('speechSynthesis' in window) || !text) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const tuning = speechTuning(emotion, profile.tone, intensity)
  utterance.lang = 'zh-CN'
  utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === profile.systemVoice) ?? null
  utterance.rate = tuning.rate
  utterance.pitch = tuning.pitch
  utterance.volume = tuning.volume
  window.speechSynthesis.speak(utterance)
}

function PetAvatar({ emotion, intensity, speaking, skin, name }: { emotion: Emotion; intensity: number; speaking: boolean; skin: string; name: string }) {
  const classes = `pet pet-${emotion}${speaking ? ' is-speaking' : ''}`
  return <div className={classes} style={{ '--intensity': intensity } as CSSProperties} aria-label={`桌宠状态：${emotion}`}>
    <div className="sparkles" aria-hidden><i /><i /><i /></div>
    <div className="ear ear-left" /><div className="ear ear-right" />
    <div className="face"><div className="eye eye-left" /><div className="eye eye-right" /><div className="blush blush-left" /><div className="blush blush-right" /><div className="mouth" /></div>
    <div className="body"><span className="badge">{name.slice(0, 6)}</span></div>
    {skin && <img className="custom-skin" src={skin} alt={`${name}的皮肤`} />}
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
      app = new PIXI.Application({ width: 190, height: 210, transparent: true, antialias: true })
      host.current?.appendChild(app.view)
      const loaded = await Live2DModel.from(modelUrl)
      if (!alive) return
      loaded.anchor?.set?.(0.5, 1); loaded.x = 95; loaded.y = 205; loaded.scale.set(0.22)
      app.stage.addChild(loaded); model.current = loaded
    })().catch((error) => console.warn('[dsh-pet] Live2D model fallback:', error))
    return () => { alive = false; model.current?.destroy?.(); app?.destroy?.(true, { children: true }) }
  }, [modelUrl])
  useEffect(() => {
    model.current?.motion?.(motionForEmotion(emotion), 2)
  }, [emotion])
  return modelUrl ? <div className="live2d" ref={host} /> : null
}

function App() {
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [intensity, setIntensity] = useState(0.45)
  const [message, setMessage] = useState('连接 DeepSeek Harness 中…')
  const [connected, setConnected] = useState(false)
  const [profile, setProfile] = useState<PetProfile>(() => loadProfile())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bootstrap, setBootstrap] = useState<BootstrapReport>({ state: 'checking', message: '正在一键配置桌宠插件…' })
  const resetTimer = useRef<number>()
  const speaking = emotion === 'speaking' || emotion === 'happy' || emotion === 'gentle'
  const bridgeToken = profile.bridgeToken || fallbackBridgeToken
  const eventSourceUrl = useMemo(() => `${bridgeUrl}${bridgeUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const profileUrl = useMemo(() => `${bridgeUrl.replace(/\/events(?:\?.*)?$/, '/profile')}?token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const characterProfile = useMemo(() => ({
    name: profile.name,
    introduction: profile.introduction,
    relationship: profile.relationship,
    tone: profile.tone,
  }), [profile.name, profile.introduction, profile.relationship, profile.tone])

  const runBootstrap = useCallback(async (dshPath?: string) => {
    setBootstrap({ state: 'checking', message: '正在一键配置桌宠插件…' })
    setConnected(false)
    try {
      const report = await invoke<BootstrapReport>('ensure_dsh_plugin', { dshPath: dshPath ?? null })
      setBootstrap(report)
      setMessage(report.message)
    } catch (error) {
      const report = { state: 'failed' as const, message: '自动配置没有完成，请重试。', detail: String(error) }
      setBootstrap(report)
      setMessage(report.message)
    }
  }, [])

  useEffect(() => { void runBootstrap() }, [runBootstrap])

  const chooseDsh = async () => {
    const selected = await open({ title: '选择 DSH Desktop.app 或 dsh 可执行文件', multiple: false, directory: false })
    if (typeof selected === 'string') await runBootstrap(selected)
  }

  const needsDshPicker = bootstrap.state === 'missing-dsh' || (bootstrap.state === 'failed' && !bootstrap.dshPath)

  const beginWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || settingsOpen) return
    const target = event.target as HTMLElement
    if (target.closest('button,input,textarea,select,label,a,[role="dialog"]')) return
    void getCurrentWindow().startDragging()
  }

  useEffect(() => {
    // Only the text persona crosses the loopback bridge. Local skins, samples,
    // system voice choices, and the authentication token stay in this app.
    void fetch(profileUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(characterProfile) }).catch(() => {})
  }, [profileUrl, characterProfile])

  useEffect(() => {
    if (bootstrap.state !== 'ready') return
    // EventSource cannot attach custom headers. The bridge also accepts the query token for native companions.
    const source = new EventSource(eventSourceUrl)
    source.onopen = () => { setConnected(true); setMessage('已连接到 DeepSeek Harness') }
    source.onerror = () => { setConnected(false); setMessage('等待 DeepSeek Harness 事件桥接…') }
    source.addEventListener('pet', async (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as PetEvent
      const level = event.intensity ?? 0.6
      const answerStillSpeaking = shouldKeepCurrentBubble(event, window.speechSynthesis.speaking)
      setEmotion(event.emotion); setIntensity(level)
      if (!answerStillSpeaking) setMessage(event.text ?? '')
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setEmotion('neutral'), event.type === 'task-complete' ? 9000 : 3500)
      if (event.text && !answerStillSpeaking) speak(event.text, event.emotion, level, profile)
      if (event.type === 'task-complete') {
        const granted = await isPermissionGranted()
        if (granted || await requestPermission() === 'granted') sendNotification({ title: 'DSH 任务已完成', body: event.text ?? '小桌宠在等你查看结果。' })
      }
    })
    return () => { source.close(); if (resetTimer.current) window.clearTimeout(resetTimer.current) }
  }, [bootstrap.state, eventSourceUrl, profile])

  const saveProfile = async (next: PetProfile) => {
    setProfile(next); localStorage.setItem('dsh-pet-profile', JSON.stringify(next)); setSettingsOpen(false)
  }

  return <main className="stage" data-connected={connected} onPointerDown={beginWindowDrag}>
    <div className="drag-handle" data-tauri-drag-region title="按住拖动桌宠"><i /><i /><i /></div>
    <div className="avatar-stage" data-tauri-drag-region>
      <PetAvatar emotion={emotion} intensity={intensity} speaking={speaking} skin={profile.skinDataUrl} name={profile.name || defaultProfile.name} />
      <Live2DStage emotion={emotion} modelUrl={profile.live2dModelUrl || (import.meta.env.VITE_LIVE2D_MODEL_URL ?? '')} />
    </div>
    {bootstrap.state !== 'ready' && bootstrap.state !== 'checking' && <button
      className="bootstrap-action"
      title={bootstrap.detail}
      onClick={() => needsDshPicker ? void chooseDsh() : void runBootstrap(bootstrap.dshPath)}
    >{bootstrap.state === 'restart-required' ? '我已重启，重新检测' : needsDshPicker ? '选择 DSH 并自动安装' : '重试自动安装'}</button>}
    <section className="bubble"><strong>{profile.name || defaultProfile.name}</strong><span title={bootstrap.detail}><i className="status-dot" />{message}</span></section>
    <button className="mute" onClick={() => window.speechSynthesis.cancel()} title="停止朗读">■</button>
    <button className="close" onClick={() => void getCurrentWindow().close()} title="退出桌宠">×</button>
    <button className="settings" onClick={() => setSettingsOpen(true)} title="角色设置">⚙</button>
    {settingsOpen && <ProfilePanel value={profile} onSave={saveProfile} onClose={() => setSettingsOpen(false)} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
