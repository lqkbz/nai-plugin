import plugin from '../../../lib/plugins/plugin.js'
import queue from '../components/Queue.js'
import Config from '../components/Config.js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import axios from 'axios'

const baseHeaders = {
  "authority": "api.novelai.net",
  "Origin": "https://novelai.net",
  "Referer": "https://novelai.net",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Content-Type": "application/json",
  "Accept": "application/json"
}

const tierMap = ['Paper', 'Tablet', 'Scroll', 'Opus']

export class User extends plugin {
  constructor() {
    super({
      name: 'nai-账户状态',
      dsc: '账户状态',
      event: 'message',
      priority: 1009,
      rule: [
        {
          reg: '^[/#]?nai --info$',
          fnc: 'info'
        },
        {
          reg: '^[/#]?nai --reload$',
          fnc: 'refresh'
        }
      ]
    })
  }

  async info(e) {
    try {
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan('开始执行info函数'))
      
      const config = Config.getConfig()
      const { novelai_token: tokens, proxy: proxyConfig, reverse_proxy } = config

      logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`获取到配置，Token数量: ${tokens?.length || 0}`))

      if (!tokens?.length) return e.reply('未配置Token，请先配置Token')

      await e.reply('正在查询中，预计10s，请稍后...')

      const agent = proxyConfig.enable 
        ? new HttpsProxyAgent(`http://${proxyConfig.host}:${proxyConfig.port}`)
        : null

      logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`代理设置: ${proxyConfig.enable ? '已启用' : '未启用'}`))
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`API地址: ${reverse_proxy.user_url}/user/data`))

      const results = await Promise.all(tokens.map(async (token, index) => {
        try {
          logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`正在验证Token ${index + 1}: ${token.substring(0, 8)}...${token.slice(-8)}`))
          
          const requestConfig = {
            headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
            timeout: 10000
          }
          
          if (agent) {
            requestConfig.httpsAgent = agent
            requestConfig.httpAgent = agent
          }
          
          logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`使用代理: ${proxyConfig.enable ? `${proxyConfig.host}:${proxyConfig.port}` : '无'}`))
          
          const response = await axios.get(`${reverse_proxy.user_url}/user/data`, requestConfig)

          logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Token ${index + 1} 验证成功，状态码: ${response.status}`))
          
          const { active, tier, expiresAt, trainingStepsLeft } = response.data.subscription
          return [
            `┌ Token: ${token.substring(0, 8)}...${token.slice(-8)}`,
            '├ 订阅状态：' + (active ? '已订阅' : '未订阅'),
            '├ 订阅挡位：' + (tierMap[tier] || '未知'),
            '├ 到期时间：' + new Date(expiresAt * 1000).toLocaleString('chinese', { hour12: false }),
            `├ 固定剩余点数：${trainingStepsLeft.fixedTrainingStepsLeft}`,
            `└ 购买的点数：${trainingStepsLeft.purchasedTrainingSteps}`
          ].join('\n')
        } catch (error) {
          const tokenDisplay = `${token.substring(0, 8)}...${token.slice(-8)}`
          let errorInfo = [
            `┌ Token: ${tokenDisplay}`,
            `├ 状态：查询失败`
          ]
          
          if (error.response) {
            // 服务器返回了错误响应
            errorInfo.push(`├ HTTP状态码：${error.response.status}`)
            errorInfo.push(`├ 状态文本：${error.response.statusText}`)
            
            if (error.response.data) {
              if (typeof error.response.data === 'string') {
                errorInfo.push(`├ 错误信息：${error.response.data}`)
              } else if (error.response.data.message) {
                errorInfo.push(`├ 错误信息：${error.response.data.message}`)
              } else {
                errorInfo.push(`├ 响应数据：${JSON.stringify(error.response.data)}`)
              }
            }
            
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Token ${index + 1} 验证失败`), logger.red(`状态码: ${error.response.status}, 响应: ${JSON.stringify(error.response.data)}`))
          } else if (error.request) {
            // 请求已发出但没有收到响应
            errorInfo.push('├ 错误类型：网络请求超时或无响应')
            errorInfo.push(`└ 错误详情：${error.message}`)
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Token ${index + 1} 网络请求失败`), logger.red(error.message))
          } else {
            // 其他错误
            errorInfo.push(`└ 错误信息：${error.message}`)
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Token ${index + 1} 其他错误`), logger.red(error.message))
          }
          
          return errorInfo.join('\n')
        }
      }))

      e.reply(`已配置${tokens.length}个Token\n\n${results.join('\n\n')}`)
      return true
    } catch (globalError) {
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red('info函数执行出错:'), logger.red(globalError.message))
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red('错误堆栈:'), logger.red(globalError.stack))
      e.reply(`查询失败: ${globalError.message}`)
      return false
    }
  }

  async refresh(e) {
    await e.reply('正在从配置文件中读取Token检查可用性，请稍后...')
    await queue.init(e)
    e.reply(`已刷新Token状态，当前共有 ${queue.list.length} 个Token可用`)
    return true
  }
}