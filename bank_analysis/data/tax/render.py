import asyncio,sys
from playwright.async_api import async_playwright
async def main(url,out):
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args=['--no-sandbox','--ignore-certificate-errors-spki-list'], proxy={'server': __import__('os').environ['HTTPS_PROXY']})
        pg=await b.new_page(ignore_https_errors=False)
        await pg.goto(url,timeout=180000,wait_until='domcontentloaded')
        await pg.wait_for_timeout(25000)
        t=await pg.inner_text('body')
        open(out,'w').write(t); print(len(t))
        await b.close()
asyncio.run(main(sys.argv[1],sys.argv[2]))
