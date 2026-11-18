/** 首页「每日一句」：按图片内容（标题 / 版权说明里的地名、景物）挑一句相配的；没有匹配就在全部里按日期轮换。 */

export type QuoteTag = "mountain" | "water" | "sky" | "flower" | "forest" | "snow" | "road" | "night" | "animal" | "rain";

export interface Quote {
  text: string;
  /** 出处；自己写的鼓励话留空 */
  author?: string;
  tags: QuoteTag[];
}

export const QUOTES: Quote[] = [
  { text: "千里之行，始于足下。", author: "老子", tags: ["road"] },
  { text: "不积跬步，无以至千里；不积小流，无以成江海。", author: "荀子", tags: ["road", "water"] },
  { text: "山重水复疑无路，柳暗花明又一村。", author: "陆游", tags: ["road", "mountain", "water", "flower"] },
  { text: "长风破浪会有时，直挂云帆济沧海。", author: "李白", tags: ["water", "sky"] },
  { text: "会当凌绝顶，一览众山小。", author: "杜甫", tags: ["mountain"] },
  { text: "沉舟侧畔千帆过，病树前头万木春。", author: "刘禹锡", tags: ["forest", "water"] },
  { text: "天行健，君子以自强不息。", author: "《周易》", tags: ["night", "sky"] },
  { text: "宝剑锋从磨砺出，梅花香自苦寒来。", author: "古语", tags: ["snow", "flower"] },
  { text: "不畏浮云遮望眼，自缘身在最高层。", author: "王安石", tags: ["mountain", "sky"] },
  { text: "欲穷千里目，更上一层楼。", author: "王之涣", tags: ["mountain", "sky", "road"] },
  { text: "海阔凭鱼跃，天高任鸟飞。", author: "古语", tags: ["water", "animal", "sky"] },
  { text: "莫等闲，白了少年头，空悲切。", author: "岳飞", tags: ["road"] },
  { text: "行到水穷处，坐看云起时。", author: "王维", tags: ["water", "sky", "mountain"] },
  { text: "仰天大笑出门去，我辈岂是蓬蒿人。", author: "李白", tags: ["sky", "road"] },
  { text: "天生我材必有用，千金散尽还复来。", author: "李白", tags: ["night"] },
  { text: "日出江花红胜火，春来江水绿如蓝。", author: "白居易", tags: ["sky", "water", "flower"] },
  { text: "接天莲叶无穷碧，映日荷花别样红。", author: "杨万里", tags: ["flower", "water", "sky"] },
  { text: "千磨万击还坚劲，任尔东西南北风。", author: "郑燮", tags: ["mountain", "snow", "forest"] },
  { text: "咬定青山不放松，立根原在破岩中。", author: "郑燮", tags: ["mountain", "forest"] },
  { text: "雄关漫道真如铁，而今迈步从头越。", author: "毛泽东", tags: ["mountain", "road"] },
  { text: "路漫漫其修远兮，吾将上下而求索。", author: "屈原", tags: ["road", "night"] },
  { text: "业精于勤，荒于嬉；行成于思，毁于随。", author: "韩愈", tags: [] },
  { text: "春风得意马蹄疾，一日看尽长安花。", author: "孟郊", tags: ["flower", "animal", "road"] },
  { text: "青山遮不住，毕竟东流去。", author: "辛弃疾", tags: ["mountain", "water"] },
  { text: "海纳百川，有容乃大。", author: "林则徐", tags: ["water"] },
  { text: "大鹏一日同风起，扶摇直上九万里。", author: "李白", tags: ["sky", "animal"] },
  { text: "星垂平野阔，月涌大江流。", author: "杜甫", tags: ["night", "water"] },
  { text: "明月松间照，清泉石上流。", author: "王维", tags: ["night", "forest", "water"] },
  { text: "竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。", author: "苏轼", tags: ["rain", "forest", "road"] },
  { text: "回首向来萧瑟处，归去，也无风雨也无晴。", author: "苏轼", tags: ["rain", "road"] },
  { text: "好风凭借力，送我上青云。", author: "《红楼梦》", tags: ["sky", "animal"] },
  { text: "锲而不舍，金石可镂。", author: "荀子", tags: ["mountain"] },
  { text: "今天不用完美，只要比昨天向前一点点。", tags: [] },
  { text: "慢一点没关系，只要没有停下来。", tags: ["road"] },
  { text: "你已经走过很多难走的路，今天也一样可以。", tags: ["road", "mountain"] },
  { text: "先迈出第一步，剩下的路会在脚下出现。", tags: ["road"] },
  { text: "把今天过好，就是对未来最好的投资。", tags: [] },
  { text: "再平凡的一天，也值得认真对待。", tags: [] },
  { text: "累了就歇一歇，天亮之后，一切都会重新开始。", tags: ["night", "sky"] },
  { text: "海内存知己，天涯若比邻。", author: "王勃", tags: ["water", "road"] },
  { text: "千淘万漉虽辛苦，吹尽狂沙始到金。", author: "刘禹锡", tags: ["water", "mountain"] },
  { text: "老骥伏枥，志在千里。", author: "曹操", tags: ["road", "animal"] },
  { text: "山高自有客行路，水深自有渡船人。", author: "古语", tags: ["mountain", "water", "road"] },
  { text: "横看成岭侧成峰，远近高低各不同。", author: "苏轼", tags: ["mountain"] },
  { text: "墙角数枝梅，凌寒独自开。", author: "王安石", tags: ["snow", "flower"] },
  { text: "忽如一夜春风来，千树万树梨花开。", author: "岑参", tags: ["snow", "flower", "forest"] },
  { text: "等闲识得东风面，万紫千红总是春。", author: "朱熹", tags: ["flower"] },
  { text: "野火烧不尽，春风吹又生。", author: "白居易", tags: ["forest", "flower"] },
  { text: "落红不是无情物，化作春泥更护花。", author: "龚自珍", tags: ["flower"] },
  { text: "我劝天公重抖擞，不拘一格降人才。", author: "龚自珍", tags: ["sky"] },
  { text: "莫道桑榆晚，为霞尚满天。", author: "刘禹锡", tags: ["sky"] },
  { text: "东边日出西边雨，道是无晴却有晴。", author: "刘禹锡", tags: ["rain", "sky"] },
  { text: "志不强者智不达，言不信者行不果。", author: "墨子", tags: [] },
  { text: "知之者不如好之者，好之者不如乐之者。", author: "《论语》", tags: [] },
  { text: "三人行，必有我师焉。", author: "《论语》", tags: [] },
  { text: "路遥知马力，日久见人心。", author: "古语", tags: ["road", "animal"] },
  { text: "世上无难事，只怕有心人。", author: "古语", tags: [] },
  { text: "绳锯木断，水滴石穿。", author: "古语", tags: ["water"] },
  { text: "登山则情满于山，观海则意溢于海。", author: "刘勰", tags: ["mountain", "water"] },
  { text: "大漠孤烟直，长河落日圆。", author: "王维", tags: ["sky", "water", "mountain"] },
  { text: "野旷天低树，江清月近人。", author: "孟浩然", tags: ["night", "water", "forest"] },
  { text: "海上生明月，天涯共此时。", author: "张九龄", tags: ["water", "night"] },
  { text: "且将新火试新茶，诗酒趁年华。", author: "苏轼", tags: [] },
  { text: "天道酬勤。", author: "古语", tags: [] },
  { text: "学而不思则罔，思而不学则殆。", author: "《论语》", tags: [] },
  { text: "把难题拆小一点，今天只解决眼前这一个。", tags: [] },
  { text: "不用赶，该来的会来，该走的路一步一步走。", tags: ["road"] },
];

/** 图片说明里出现这些字，就认为画面里有对应的景物 */
const TAG_WORDS: Record<QuoteTag, string[]> = {
  mountain: ["山", "峰", "峡谷", "崖", "岭", "高原", "冰川", "火山", "岩", "沙丘", "沙漠"],
  water: ["海", "湖", "河", "瀑布", "江", "岸", "湾", "水", "溪", "洋", "岛", "礁", "港", "泉"],
  sky: ["日出", "日落", "朝霞", "晨", "黎明", "曙光", "阳光", "天空", "云", "晚霞", "黄昏", "彩虹", "气球"],
  flower: ["花", "春", "樱", "薰衣草", "郁金香", "向日葵", "果园"],
  forest: ["林", "树", "森林", "草原", "田", "叶", "雪松", "竹", "枫", "杉", "松"],
  snow: ["雪", "冰", "冬", "霜", "雾凇"],
  road: ["路", "桥", "步道", "小径", "街", "城", "铁路", "车", "塔", "村", "古道", "阶梯", "台阶"],
  night: ["星", "夜", "月", "极光", "银河", "灯"],
  animal: ["鸟", "鹰", "鲸", "鹿", "熊", "狐", "企鹅", "鱼", "象", "狼", "马", "鹤", "猫", "狮", "海豹", "蝴蝶"],
  rain: ["雨", "雾", "烟", "霭"],
};

export function detectTags(hint: string): QuoteTag[] {
  return (Object.keys(TAG_WORDS) as QuoteTag[]).filter(t => TAG_WORDS[t].some(w => hint.includes(w)));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 挑一句：优先选和图片相配、且没用过的；相配的都用过了就在所有没用过的里选；
 * 全部用过一轮才重新开始。`used` 由调用方记录。同一天同样的输入永远得到同一句。
 */
export function pickQuote(date: string, hint = "", used: ReadonlySet<string> = new Set()): Quote {
  const tags = detectTags(hint);
  const fresh = (q: Quote) => !used.has(q.text);
  let pool = tags.length ? QUOTES.filter(q => fresh(q) && q.tags.some(t => tags.includes(t))) : [];
  if (!pool.length) pool = QUOTES.filter(fresh);
  if (!pool.length) {
    // 整个句库都用过一轮：重新开始，仍优先相配的
    const all = tags.length ? QUOTES.filter(q => q.tags.some(t => tags.includes(t))) : [];
    pool = all.length ? all : QUOTES;
  }
  return pool[hash(date) % pool.length];
}
