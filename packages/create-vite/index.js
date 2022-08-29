#!/usr/bin/env node

// @ts-check
const fs = require('fs')
const path = require('path')
// Avoids autoconversion to number of the project name by defining that the args
// non associated with an option ( _ ) needs to be parsed as a string. See #4606
const argv = require('minimist')(process.argv.slice(2), { string: ['_'] })
// eslint-disable-next-line node/no-restricted-require
const prompts = require('prompts')
const {
  yellow,
  green,
  cyan,
  blue,
  magenta,
  lightRed,
  red,
  reset
} = require('kolorist')

const cwd = process.cwd() // 工作目录，即 调用 node 命令执行脚本时的目录

// 框架列表
const FRAMEWORKS = [
  {
    name: 'vanilla',
    color: yellow,
    variants: [
      {
        name: 'vanilla',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'vanilla-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  },
  {
    name: 'vue',
    color: green,
    // 变体、类型等
    variants: [
      {
        name: 'vue',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'vue-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  },
  {
    name: 'react',
    color: cyan,
    variants: [
      {
        name: 'react',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'react-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  },
  {
    name: 'preact',
    color: magenta,
    variants: [
      {
        name: 'preact',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'preact-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  },
  {
    name: 'lit',
    color: lightRed,
    variants: [
      {
        name: 'lit',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'lit-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  },
  {
    name: 'svelte',
    color: red,
    variants: [
      {
        name: 'svelte',
        display: 'JavaScript',
        color: yellow
      },
      {
        name: 'svelte-ts',
        display: 'TypeScript',
        color: blue
      }
    ]
  }
]

// 所有的模版列表
const TEMPLATES = FRAMEWORKS.map(
  (f) => (f.variants && f.variants.map((v) => v.name)) || [f.name]
).reduce((a, b) => a.concat(b), [])

const renameFiles = {
  _gitignore: '.gitignore'
}

/**
 * 执行入口
 * eg: npm create vite@latest my-vue-app --template vue
 * @returns
 */
async function init() {
  // 第一个参数：目录
  let targetDir = argv._[0]
  // 第二个参数：模版名
  let template = argv.template || argv.t

  // 默认的项目名
  const defaultProjectName = !targetDir ? 'vite-project' : targetDir

  let result = {}

  try {
    // QA 列表
    result = await prompts(
      [
        // 填写项目名称
        {
          type: targetDir ? null : 'text',
          name: 'projectName',
          message: reset('Project name:'),
          initial: defaultProjectName,
          onState: (state) =>
            (targetDir = state.value.trim() || defaultProjectName)
        },
        // 项目名确认 或 重写
        {
          type: () =>
            !fs.existsSync(targetDir) || isEmpty(targetDir) ? null : 'confirm',
          name: 'overwrite',
          message: () =>
            (targetDir === '.'
              ? 'Current directory'
              : `Target directory "${targetDir}"`) +
            ` is not empty. Remove existing files and continue?`
        },
        {
          type: (_, { overwrite } = {}) => {
            if (overwrite === false) {
              throw new Error(red('✖') + ' Operation cancelled')
            }
            return null
          },
          name: 'overwriteChecker'
        },
        // packageName
        {
          type: () => (isValidPackageName(targetDir) ? null : 'text'),
          name: 'packageName',
          message: reset('Package name:'),
          initial: () => toValidPackageName(targetDir),
          validate: (dir) =>
            isValidPackageName(dir) || 'Invalid package.json name'
        },
        // 选择框架
        {
          type: template && TEMPLATES.includes(template) ? null : 'select',
          name: 'framework',
          message:
            typeof template === 'string' && !TEMPLATES.includes(template)
              ? reset(
                  `"${template}" isn't a valid template. Please choose from below: `
                )
              : reset('Select a framework:'),
          initial: 0,
          choices: FRAMEWORKS.map((framework) => {
            const frameworkColor = framework.color
            return {
              title: frameworkColor(framework.name),
              value: framework
            }
          })
        },
        // 选择 variant
        {
          type: (framework) =>
            framework && framework.variants ? 'select' : null,
          name: 'variant',
          message: reset('Select a variant:'),
          // @ts-ignore
          choices: (framework) =>
            framework.variants.map((variant) => {
              const variantColor = variant.color
              return {
                title: variantColor(variant.name),
                value: variant.name
              }
            })
        }
      ],
      {
        onCancel: () => {
          throw new Error(red('✖') + ' Operation cancelled')
        }
      }
    )
  } catch (cancelled) {
    console.log(cancelled.message)
    return
  }

  // user choice associated with prompts
  const { framework, overwrite, packageName, variant } = result

  // 项目跟目录
  const root = path.join(cwd, targetDir)

  if (overwrite) {
    // 重写的情况下，先清空
    emptyDir(root)
  } else if (!fs.existsSync(root)) {
    // 不存在目录，就创建
    fs.mkdirSync(root)
  }

  // determine template
  template = variant || framework || template

  console.log(`\nScaffolding project in ${root}...`)

  // 模版地址
  const templateDir = path.join(__dirname, `template-${template}`)

  // 定义了一个写文件的方法(处理文件和文件夹)
  const write = (file, content) => {
    const targetPath = renameFiles[file]
      ? path.join(root, renameFiles[file])
      : path.join(root, file)
    if (content) {
      fs.writeFileSync(targetPath, content)
    } else {
      copy(path.join(templateDir, file), targetPath)
    }
  }

  // 第一：处理模版目录下的一级文件，除了 package.json
  const files = fs.readdirSync(templateDir)
  for (const file of files.filter((f) => f !== 'package.json')) {
    // 除了 package.json 都拷贝并写入
    write(file)
  }

  // 第二：处理 package.json 文件
  const pkg = require(path.join(templateDir, `package.json`))
  pkg.name = packageName || targetDir
  write('package.json', JSON.stringify(pkg, null, 2))

  // 无论是 yarn 或者 npm 等包管理器，都会向环境变量中注入 npm_config_user_agent 携带自身信息。
  // npm_config_user_agent
  const pkgInfo = pkgFromUserAgent(process.env.npm_config_user_agent)
  const pkgManager = pkgInfo ? pkgInfo.name : 'npm'

  console.log(`\nDone. Now run:\n`)
  if (root !== cwd) {
    console.log(`  cd ${path.relative(cwd, root)}`)
  }
  switch (pkgManager) {
    case 'yarn':
      console.log('  yarn')
      console.log('  yarn dev')
      break
    default:
      console.log(`  ${pkgManager} install`)
      console.log(`  ${pkgManager} run dev`)
      break
  }
  console.log()
}

function copy(src, dest) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    copyDir(src, dest)
  } else {
    fs.copyFileSync(src, dest)
  }
}

function isValidPackageName(projectName) {
  return /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(
    projectName
  )
}

function toValidPackageName(projectName) {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]/, '')
    .replace(/[^a-z0-9-~]+/g, '-')
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.resolve(srcDir, file)
    const destFile = path.resolve(destDir, file)
    copy(srcFile, destFile)
  }
}

function isEmpty(path) {
  return fs.readdirSync(path).length === 0
}

function emptyDir(dir) {
  if (!fs.existsSync(dir)) {
    return
  }
  for (const file of fs.readdirSync(dir)) {
    const abs = path.resolve(dir, file)
    // baseline is Node 12 so can't use rmSync :(
    if (fs.lstatSync(abs).isDirectory()) {
      emptyDir(abs)
      fs.rmdirSync(abs)
    } else {
      fs.unlinkSync(abs)
    }
  }
}

/**
 * @param {string | undefined} userAgent process.env.npm_config_user_agent
 * @returns object | undefined
 */
function pkgFromUserAgent(userAgent) {
  if (!userAgent) return undefined
  const pkgSpec = userAgent.split(' ')[0]
  const pkgSpecArr = pkgSpec.split('/')
  return {
    name: pkgSpecArr[0],
    version: pkgSpecArr[1]
  }
}

init().catch((e) => {
  console.error(e)
})
