import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Link } from 'react-router-dom'
import { CHARACTER_PROFILES } from '../lib/characterProfiles'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './landing.css'

const profile = CHARACTER_PROFILES[0]
const amounts = Array.from({ length: 10 }, (_, idx) => (idx + 1) * 1000)
const OAUTH_REDIRECT_URL =
  typeof window !== 'undefined' ? new URL('/lp', window.location.origin).toString() : undefined

type OmikujiDraw = {
  amount: number
  createdAt: string
}

export function Landing() {
  const [session, setSession] = useState<Session | null>(null)
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [draw, setDraw] = useState<OmikujiDraw | null>(null)
  const [drawStatus, setDrawStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [drawMessage, setDrawMessage] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthStatus('idle')
      setAuthMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (!url.searchParams.has('code') || !url.searchParams.has('state')) return
    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  useEffect(() => {
    if (!supabase || !session?.user?.id) {
      setDraw(null)
      setDrawMessage('')
      setDrawStatus('idle')
      return
    }
    let active = true
    const loadDraw = async () => {
      const { data, error } = await supabase
        .from('omikuji_draws')
        .select('amount, created_at')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (!active) return
      if (error) {
        setDrawStatus('error')
        setDrawMessage(error.message)
        return
      }
      if (data) {
        setDraw({
          amount: data.amount,
          createdAt: data.created_at,
        })
        setDrawStatus('done')
      }
    }
    void loadDraw()
    return () => {
      active = false
    }
  }, [session?.user?.id])

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('認証の設定が未完了です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setAuthStatus('error')
      setAuthMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setAuthStatus('error')
    setAuthMessage('認証URLを取得できませんでした。')
  }

  const handleDraw = async () => {
    if (!session?.user?.id) {
      setDrawMessage('ログインすると引けます。')
      return
    }
    if (draw) {
      setDrawMessage('このアカウントは既に引いています。')
      return
    }
    setDrawStatus('loading')
    setDrawMessage('')
    const amount = amounts[Math.floor(Math.random() * amounts.length)]
    const { data, error } = await supabase
      .from('omikuji_draws')
      .insert({
        user_id: session.user.id,
        amount,
      })
      .select('amount, created_at')
      .single()
    if (error) {
      if (error.code === '23505') {
        setDrawMessage('このアカウントは既に引いています。')
        const { data: existing } = await supabase
          .from('omikuji_draws')
          .select('amount, created_at')
          .eq('user_id', session.user.id)
          .maybeSingle()
        if (existing) {
          setDraw({
            amount: existing.amount,
            createdAt: existing.created_at,
          })
          setDrawStatus('done')
        } else {
          setDrawStatus('idle')
        }
        return
      }
      setDrawStatus('error')
      setDrawMessage(error.message)
      return
    }
    setDraw({
      amount: data.amount,
      createdAt: data.created_at,
    })
    setDrawStatus('done')
  }

  return (
    <div className="lp lp-omikuji">
      <header className="lp__header">
        <div className="lp__brand">
          <img src={profile.image} alt={profile.name} />
          <div>
            <div className="lp__brand-name">おみくじキャンペーン</div>
            <div className="lp__brand-sub">1アカウント1回限定</div>
          </div>
        </div>
        <div className="lp__actions">
          <Link className="ghost" to="/">
            チャットへ
          </Link>
          {session ? (
            <span className="lp__signed">{session.user?.email || 'ログイン中'}</span>
          ) : (
            <button type="button" className="ghost" onClick={handleGoogleSignIn} disabled={authStatus === 'loading'}>
              {authStatus === 'loading' ? '起動中...' : 'Googleでログイン'}
            </button>
          )}
        </div>
      </header>

      <section className="omikuji-hero">
        <div className="omikuji-card">
          <div className="omikuji-card__badge">福みくじ</div>
          <h1>1回きりの運試し</h1>
          <p>1,000円〜10,000円の中からどれかが当たる。各10%で公平。</p>
          <div className={`omikuji-card__box ${drawStatus === 'loading' ? 'is-loading' : ''}`}>
            {draw ? (
              <>
                <div className="omikuji-result__label">結果</div>
                <div className="omikuji-result__amount">{draw.amount.toLocaleString()}円</div>
                <div className="omikuji-result__meta">
                  {new Date(draw.createdAt).toLocaleString()} に抽選済み
                </div>
              </>
            ) : (
              <>
                <div className="omikuji-result__label">未抽選</div>
                <div className="omikuji-result__amount">???,???円</div>
                <div className="omikuji-result__meta">ログイン後に引けます</div>
              </>
            )}
          </div>
          <button
            type="button"
            className="primary omikuji-button"
            onClick={handleDraw}
            disabled={drawStatus === 'loading' || Boolean(draw)}
          >
            {drawStatus === 'loading' ? '抽選中…' : draw ? '抽選済み' : 'おみくじを引く'}
          </button>
          {drawMessage && <div className="omikuji-message">{drawMessage}</div>}
          {authMessage && <div className="omikuji-message error">{authMessage}</div>}
        </div>

        <div className="omikuji-info">
          <div className="lp__card">
            <h3>ルール</h3>
            <ul>
              <li>Googleログイン後に1回だけ</li>
              <li>各金額の確率は10%</li>
              <li>2回目は引けません</li>
            </ul>
          </div>
          <div className="lp__card">
            <h3>当選額一覧</h3>
            <div className="amount-grid">
              {amounts.map((value) => (
                <span key={value}>{value.toLocaleString()}円</span>
              ))}
            </div>
          </div>
          <div className="lp__card">
            <h3>彩香のひとこと</h3>
            <p>結果は運次第。引くなら今よ、べ、別にあなたのためじゃないんだからね。</p>
          </div>
        </div>
      </section>

      <footer className="lp__footer">
        抽選は1アカウント1回限りです。
      </footer>
    </div>
  )
}
