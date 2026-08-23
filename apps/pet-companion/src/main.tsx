import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { open } from '@tauri-apps/plugin-dialog'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { defaultProfile, loadProfile, ProfilePanel, type PetProfile } from './profile'
import { shouldKeepCurrentBubble, speechTuning, type Emotion } from './personality'
import type { PetEvent } from './types'
import { AvatarStage } from './AvatarStage'
import { startMicrophoneRecording, transcribeRecording } from './speech-input'
import './styles.css'

const bridgeUrl = import.meta.env.VITE_DSH_PET_BRIDGE ?? 'http://127.0.0.1:3080/dsh-pet/events'
const fallbackBridgeToken = import.meta.env.VITE_DSH_PET_TOKEN ?? 'change-me-before-production'

type BootstrapState = 'checking' | 'ready' | 'missing-dsh' | 'restart-required' | 'failed'
type BootstrapReport = { state: BootstrapState; message: string; dshPath?: string; detail?: string }
const normalizeScale = (value: number) => Number.isFinite(value) ? Math.max(0.65, Math.min(1.65, value)) : 1

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

function App() {
  const [emotion, setEmotion] = useState<Emotion>('neutral')
  const [intensity, setIntensity] = useState(0.45)
  const [message, setMessage] = useState('连接 DeepSeek Harness 中…')
  const [connected, setConnected] = useState(false)
  const [profile, setProfile] = useState<PetProfile>(() => loadProfile())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bootstrap, setBootstrap] = useState<BootstrapReport>({ state: 'checking', message: '正在一键配置桌宠插件…' })
  const [scale, setScale] = useState(() => normalizeScale(Number(localStorage.getItem('dsh-pet-scale') || 1)))
  const [micState, setMicState] = useState<'idle' | 'listening' | 'loading' | 'transcribing' | 'sending'>('idle')
  const resetTimer = useRef<number>()
  const recording = useRef<Awaited<ReturnType<typeof startMicrophoneRecording>>>()
  const speaking = emotion === 'speaking' || emotion === 'happy' || emotion === 'gentle'
  const bridgeToken = profile.bridgeToken || fallbackBridgeToken
  const eventSourceUrl = useMemo(() => `${bridgeUrl}${bridgeUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const profileUrl = useMemo(() => `${bridgeUrl.replace(/\/events(?:\?.*)?$/, '/profile')}?token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
  const chatUrl = useMemo(() => `${bridgeUrl.replace(/\/events(?:\?.*)?$/, '/chat')}?token=${encodeURIComponent(bridgeToken)}`, [bridgeToken])
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
  useEffect(() => { void getCurrentWindow().setSize(new LogicalSize(Math.round(280 * scale), Math.round(330 * scale))) }, [])
  useEffect(() => {
    const syncToWindow = () => {
      const next = normalizeScale(Math.min(window.innerWidth / 280, window.innerHeight / 330))
      setScale(next); localStorage.setItem('dsh-pet-scale', String(next))
    }
    window.addEventListener('resize', syncToWindow)
    return () => window.removeEventListener('resize', syncToWindow)
  }, [])

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

  const resizePet = async (delta: number) => {
    const next = normalizeScale(Math.round((scale + delta) * 10) / 10)
    setScale(next); localStorage.setItem('dsh-pet-scale', String(next))
    await getCurrentWindow().setSize(new LogicalSize(Math.round(280 * next), Math.round(330 * next)))
  }

  const toggleMicrophone = async () => {
    if (micState === 'listening' && recording.current) {
      const active = recording.current; recording.current = undefined
      setMicState('transcribing'); setMessage('正在识别你刚才说的话…'); setEmotion('thinking')
      try {
        const blob = await active.stop()
        const text = await transcribeRecording(blob, (state) => {
          setMicState(state); setMessage(state === 'loading' ? '首次使用：正在下载并缓存本地语音模型…' : '正在把语音转换成文字…')
        })
        if (!text) throw new Error('没有识别到清晰语音，请靠近麦克风再试一次。')
        setMicState('sending'); setMessage(`你说：${text}`)
        const response = await fetch(chatUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.error || `DSH 拒绝了语音消息（${response.status}）`)
        setMessage(`已发送：${text}`); setEmotion('thinking')
      } catch (error) { setMessage(String(error).replace(/^Error:\s*/, '')); setEmotion('error') }
      finally { setMicState('idle') }
      return
    }
    if (micState !== 'idle') return
    try {
      window.speechSynthesis.cancel()
      recording.current = await startMicrophoneRecording()
      setMicState('listening'); setEmotion('listening'); setMessage('我在听，讲完后再点一次麦克风…')
    } catch (error) { setMessage(`无法使用麦克风：${String(error).replace(/^Error:\s*/, '')}`); setEmotion('error') }
  }

  useEffect(() => () => recording.current?.cancel(), [])

  return <main className="stage" data-connected={connected} onPointerDown={beginWindowDrag}><div className="pet-shell" style={{ '--pet-scale': scale } as CSSProperties}>
    <div className="ambient-decor" aria-hidden><i>♥</i><i>✦</i><i>●</i><i>✧</i><i>♥</i></div>
    <div className="drag-handle" data-tauri-drag-region title="按住拖动桌宠"><i /><i /><i /></div>
    <div className="avatar-stage" data-tauri-drag-region>
      <AvatarStage profile={profile} emotion={emotion} intensity={intensity} speaking={speaking} />
    </div>
    {bootstrap.state !== 'ready' && bootstrap.state !== 'checking' && <button
      className="bootstrap-action"
      title={bootstrap.detail}
      onClick={() => needsDshPicker ? void chooseDsh() : void runBootstrap(bootstrap.dshPath)}
    >{bootstrap.state === 'restart-required' ? '我已重启，重新检测' : needsDshPicker ? '选择 DSH 并自动安装' : '重试自动安装'}</button>}
    <section className="bubble"><strong><b aria-hidden>♡</b>{profile.name || defaultProfile.name}<em>{connected ? '陪伴中' : '连接中'}</em></strong><span title={bootstrap.detail}><i className="status-dot" />{message}</span></section>
    <button className="mute" onClick={() => window.speechSynthesis.cancel()} title="停止朗读">♪</button>
    <button className={`microphone mic-${micState}`} disabled={bootstrap.state !== 'ready'} onClick={() => void toggleMicrophone()} title={micState === 'listening' ? '停止录音并发送' : '语音输入'}>{micState === 'listening' ? '■' : '🎙'}</button>
    <div className="scale-controls"><button onClick={() => void resizePet(-0.1)} title="缩小桌宠"><span>−</span></button><button onClick={() => void resizePet(0.1)} title="放大桌宠"><span>＋</span></button></div>
    <button className="close" onClick={() => void getCurrentWindow().close()} title="退出桌宠">×</button>
    <button className="settings" onClick={() => setSettingsOpen(true)} title="角色设置">⚙</button>
    {settingsOpen && <ProfilePanel value={profile} onSave={saveProfile} onClose={() => setSettingsOpen(false)} />}
  </div></main>
}

createRoot(document.getElementById('root')!).render(<App />)
