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
  // —— 现代 / 白话励志（名言、谚语、自己写的鼓励话）——
  { text: "世上本没有路，走的人多了，也便成了路。", author: "鲁迅", tags: ["road"] },
  { text: "愿中国青年都摆脱冷气，只是向上走。", author: "鲁迅", tags: ["sky"] },
  { text: "人可以被毁灭，但不能被打败。", author: "海明威", tags: ["water", "animal"] },
  { text: "世界上只有一种英雄主义，就是看清生活的真相之后依然热爱生活。", author: "罗曼·罗兰", tags: [] },
  { text: "天才是百分之一的灵感，加百分之九十九的汗水。", author: "爱迪生", tags: [] },
  { text: "天空没有留下鸟的痕迹，但我已飞过。", author: "泰戈尔", tags: ["sky", "animal"] },
  { text: "那些杀不死我的，会使我更强大。", author: "尼采", tags: ["mountain", "snow"] },
  { text: "每一个不曾起舞的日子，都是对生命的辜负。", author: "尼采", tags: ["flower"] },
  { text: "求知若饥，虚心若愚。", author: "史蒂夫·乔布斯", tags: [] },
  { text: "种一棵树最好的时间是十年前，其次是现在。", author: "谚语", tags: ["forest"] },
  { text: "知行合一，在事上磨炼。", author: "王阳明", tags: [] },
  { text: "合抱之木，生于毫末；九层之台，起于累土。", author: "老子", tags: ["forest", "mountain"] },
  { text: "骐骥一跃，不能十步；驽马十驾，功在不舍。", author: "荀子", tags: ["animal", "road"] },
  { text: "凡事预则立，不预则废。", author: "《礼记》", tags: [] },
  { text: "不要等到万事俱备，先开始，路上再补齐。", tags: ["road"] },
  { text: "你不需要看清整条楼梯，只要迈出眼前这一级。", tags: ["road", "mountain"] },
  { text: "难的事情，做着做着就会变得不那么难。", tags: ["mountain"] },
  { text: "今天多做一点点，积累起来就是巨大的差别。", tags: [] },
  { text: "别和别人比速度，你只需要比昨天的自己更好。", tags: ["road"] },
  { text: "能把一件小事做到位，也是一种了不起的本事。", tags: [] },
  { text: "困难是暂时的，你学会的东西是永远的。", tags: ["mountain"] },
  { text: "卡住了不是你不行，只是还差一个没试过的办法。", tags: ["road"] },
  { text: "每解决一个 bug，你都比昨天更懂这个系统。", tags: [] },
  { text: "先让它跑起来，再让它跑得好。", tags: ["road"] },
  { text: "今天的努力，会在你想不到的某一天回报你。", tags: ["sky"] },
  { text: "做完比完美重要，开始比想好重要。", tags: [] },
  { text: "你比自己想象的更有能力，只是还没被逼到那一步。", tags: ["mountain"] },
  { text: "辛苦的日子也是在积蓄力量，看不见的地方在悄悄生长。", tags: ["forest", "flower"] },
  { text: "风浪越大，船越要往前开。", tags: ["water", "sky"] },
  { text: "一天一点点，你会走到现在想都不敢想的地方。", tags: ["road", "mountain"] },
  { text: "愿你今天的每一次尝试，都有回响。", tags: ["sky", "night"] },
  { text: "好好休息，明天又是可以重新出发的一天。", tags: ["night"] },
  { text: "天黑了也不怕，星星正是在这时候出现的。", tags: ["night", "sky"] },
  { text: "冬天再长，春天也会来。", tags: ["snow", "flower"] },
  { text: "云层之上永远是晴天，再坚持一下。", tags: ["sky", "mountain"] },
  { text: "水滴很小，但它从不怀疑自己能到达大海。", tags: ["water"] },
  { text: "山就在那里，一步一步，总会走到顶。", tags: ["mountain"] },
  // —— 书籍摘录（经典古籍 + 中外名著 + 科幻 / 技术书）——
  { text: "岁寒，然后知松柏之后凋也。", author: "《论语》", tags: ["snow", "forest"] },
  { text: "朝闻道，夕死可矣。", author: "《论语》", tags: [] },
  { text: "温故而知新，可以为师矣。", author: "《论语》", tags: [] },
  { text: "见贤思齐焉，见不贤而内自省也。", author: "《论语》", tags: [] },
  { text: "知之为知之，不知为不知，是知也。", author: "《论语》", tags: [] },
  { text: "士不可以不弘毅，任重而道远。", author: "《论语》", tags: ["road"] },
  { text: "譬如为山，未成一篑，止，吾止也；譬如平地，虽覆一篑，进，吾往也。", author: "《论语》", tags: ["mountain", "road"] },
  { text: "天将降大任于是人也，必先苦其心志，劳其筋骨，饿其体肤。", author: "《孟子》", tags: ["mountain"] },
  { text: "生于忧患，死于安乐。", author: "《孟子》", tags: [] },
  { text: "富贵不能淫，贫贱不能移，威武不能屈。", author: "《孟子》", tags: [] },
  { text: "上善若水，水善利万物而不争。", author: "《道德经》", tags: ["water"] },
  { text: "知人者智，自知者明；胜人者有力，自胜者强。", author: "《道德经》", tags: [] },
  { text: "天下难事，必作于易；天下大事，必作于细。", author: "《道德经》", tags: [] },
  { text: "祸兮福之所倚，福兮祸之所伏。", author: "《道德经》", tags: [] },
  { text: "吾生也有涯，而知也无涯。", author: "《庄子》", tags: ["sky"] },
  { text: "水之积也不厚，则其负大舟也无力。", author: "《庄子》", tags: ["water"] },
  { text: "青，取之于蓝，而青于蓝；冰，水为之，而寒于水。", author: "《荀子》", tags: ["snow", "water"] },
  { text: "君子博学而日参省乎己，则知明而行无过矣。", author: "《荀子》", tags: [] },
  { text: "吾尝终日而思矣，不如须臾之所学也。", author: "《荀子》", tags: [] },
  { text: "玉不琢，不成器；人不学，不知道。", author: "《礼记》", tags: [] },
  { text: "学然后知不足，教然后知困。", author: "《礼记》", tags: [] },
  { text: "苟日新，日日新，又日新。", author: "《大学》", tags: ["sky"] },
  { text: "博学之，审问之，慎思之，明辨之，笃行之。", author: "《中庸》", tags: [] },
  { text: "穷则变，变则通，通则久。", author: "《周易》", tags: ["road"] },
  { text: "桃李不言，下自成蹊。", author: "《史记》", tags: ["flower", "forest", "road"] },
  { text: "燕雀安知鸿鹄之志哉！", author: "《史记》", tags: ["sky", "animal"] },
  { text: "知己知彼，百战不殆。", author: "《孙子兵法》", tags: [] },
  { text: "有志者，事竟成。", author: "《后汉书》", tags: [] },
  { text: "勿以恶小而为之，勿以善小而不为。", author: "《三国志》", tags: [] },
  { text: "非淡泊无以明志，非宁静无以致远。", author: "诸葛亮《诫子书》", tags: ["night", "water"] },
  { text: "夫学须静也，才须学也。", author: "诸葛亮《诫子书》", tags: [] },
  { text: "先天下之忧而忧，后天下之乐而乐。", author: "范仲淹《岳阳楼记》", tags: ["water"] },
  { text: "不以物喜，不以己悲。", author: "范仲淹《岳阳楼记》", tags: ["water", "sky"] },
  { text: "穷且益坚，不坠青云之志。", author: "王勃《滕王阁序》", tags: ["sky"] },
  { text: "老当益壮，宁移白首之心？", author: "王勃《滕王阁序》", tags: [] },
  { text: "闻道有先后，术业有专攻。", author: "韩愈《师说》", tags: [] },
  { text: "少年强则国强，少年进步则国进步。", author: "梁启超《少年中国说》", tags: ["sky"] },
  { text: "红日初升，其道大光。", author: "梁启超《少年中国说》", tags: ["sky"] },
  { text: "志不立，天下无可成之事。", author: "王阳明", tags: [] },
  { text: "幼而学者，如日出之光；老而学者，如秉烛夜行，犹贤乎瞑目而无见者。", author: "《颜氏家训》", tags: ["sky", "night"] },
  { text: "有一分热，发一分光，就令萤火一般，也可以在黑暗里发一点光，不必等候炬火。", author: "鲁迅《热风》", tags: ["night"] },
  { text: "人是为了活着本身而活着的，而不是为了活着之外的任何事物所活着。", author: "余华《活着》", tags: [] },
  { text: "生活不能等待别人来安排，要自己去争取和奋斗。", author: "路遥《平凡的世界》", tags: ["road"] },
  { text: "给岁月以文明，而不是给文明以岁月。", author: "刘慈欣《三体》", tags: ["night", "sky"] },
  { text: "弱小和无知不是生存的障碍，傲慢才是。", author: "刘慈欣《三体》", tags: [] },
  { text: "生如夏花之绚烂，死如秋叶之静美。", author: "泰戈尔《飞鸟集》", tags: ["flower", "forest"] },
  { text: "如果你因失去了太阳而流泪，那么你也将失去群星了。", author: "泰戈尔《飞鸟集》", tags: ["sky", "night"] },
  { text: "使沙漠变得美丽的，是它在某个角落藏着一口井。", author: "圣埃克苏佩里《小王子》", tags: ["mountain", "road"] },
  { text: "真正重要的东西，用眼睛是看不见的，只有用心才能看见。", author: "圣埃克苏佩里《小王子》", tags: [] },
  { text: "如果一个人满怀信心地朝着梦想的方向前进，努力过他想象中的生活，他必将获得意外的成功。", author: "梭罗《瓦尔登湖》", tags: ["forest", "water", "road"] },
  { text: "凡是自强不息者，终能得救。", author: "歌德《浮士德》", tags: [] },
  { text: "我不是鸟，没有罗网捕捉我；我是自由的人，有独立的意志。", author: "夏洛蒂·勃朗特《简·爱》", tags: ["animal", "sky"] },
  { text: "毕竟，明天又是新的一天。", author: "玛格丽特·米切尔《飘》", tags: ["sky"] },
  { text: "人类的全部智慧就包含在这两个词里：等待和希望。", author: "大仲马《基督山伯爵》", tags: ["water"] },
  { text: "世界上最宽阔的是海洋，比海洋更宽阔的是天空，比天空更宽阔的是人的胸怀。", author: "雨果《悲惨世界》", tags: ["water", "sky"] },
  { text: "钢是在烈火和急冷中炼成的。", author: "奥斯特洛夫斯基《钢铁是怎样炼成的》", tags: ["mountain"] },
  { text: "走自己的路，让别人去说吧。", author: "但丁《神曲》", tags: ["road"] },
  { text: "希望是美好的事物，也许是世间最美好的事物。", author: "斯蒂芬·金《肖申克的救赎》", tags: [] },
  { text: "阻碍行动的东西，反而推动行动；横在路上的障碍，反而成为路。", author: "马可·奥勒留《沉思录》", tags: ["road", "mountain"] },
  { text: "知识就是力量。", author: "培根《新工具》", tags: [] },
  { text: "过早优化是万恶之源。", author: "高德纳（Knuth）", tags: [] },
  { text: "先让它能跑，再让它正确，最后让它快。", author: "肯特·贝克", tags: ["road"] },
  { text: "简单是可靠的先决条件。", author: "迪杰斯特拉", tags: [] },
  { text: "预测未来最好的方式，就是去创造它。", author: "艾伦·凯", tags: ["sky"] },
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
