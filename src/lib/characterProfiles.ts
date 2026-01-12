export type CharacterProfile = {
  id: string
  name: string
  handle: string
  title: string
  location?: string
  bio: string
  motto: string
  image: string
}

export const CHARACTER_PROFILES: CharacterProfile[] = [
  {
    id: 'ayaka',
    name: '彩香',
    handle: '@ayaka',
    title: '個人投資家 / リスク管理重視',
    location: 'ロサンゼルス在住',
    bio:
      '20代前半で借金と失職 -> XMでFXを独学 -> 連敗と破産寸前 -> 記録と資金管理で再起 -> 数年で資産を築く。',
    motto: '勝つより生き残れ / 期待値と規律がすべて / 派手さより再現性',
    image: '/media/ayaka.png',
  },
]
