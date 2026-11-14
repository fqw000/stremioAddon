说明：

### catalog
https://trybox.app/_serverFn/8071ddde1fc9ba14bf80594e08c4f8cfb030a79f7bcccfe292835b561fae77a4

也可以使用payload参数指定类型比如：
https://trybox.app/_serverFn/8071ddde1fc9ba14bf80594e08c4f8cfb030a79f7bcccfe292835b561fae77a4?payload=%7B%22t%22%3A%7B%22t%22%3A10%2C%22i%22%3A0%2C%22p%22%3A%7B%22k%22%3A%5B%22data%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A10%2C%22i%22%3A1%2C%22p%22%3A%7B%22k%22%3A%5B%22page%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A1%2C%22s%22%3A%22movies%22%7D%5D%7D%2C%22o%22%3A0%7D%5D%7D%2C%22o%22%3A0%7D%2C%22f%22%3A127%2C%22m%22%3A%5B%5D%7D'

payload={"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["page"],"v":[{"t":1,"s":"movies"}]},"o":0}]},"o":0},"f":127,"m":[]}
参数支持： tv home movies三种类型。


catalog返回的id就是ttID，meta中payload中的ttId


### search

https://trybox.app/_serverFn/4554bac009cb7b0dd4f23b35e6381cde80f8891f6cd2c529ecb25d91e64f42ba?payload=%7B%22t%22%3A%7B%22t%22%3A10%2C%22i%22%3A0%2C%22p%22%3A%7B%22k%22%3A%5B%22data%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A10%2C%22i%22%3A1%2C%22p%22%3A%7B%22k%22%3A%5B%22query%22%2C%22type%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A1%2C%22s%22%3A%22%E9%98%BF%E7%94%98%E6%AD%A3%E4%BC%A0%22%7D%2C%7B%22t%22%3A1%2C%22s%22%3A%22multi%22%7D%5D%7D%2C%22o%22%3A0%7D%5D%7D%2C%22o%22%3A0%7D%2C%22f%22%3A127%2C%22m%22%3A%5B%5D%7D'

payload参数设置 multi可以综合查询，不需要在单独使用movie tv了.

### meta：
https://trybox.app/_serverFn/44b25540de850d9a6aa33c2f3333282561e7954b1805fa7e0ab1e5862f1123bc?payload=%7B%22t%22%3A%7B%22t%22%3A10%2C%22i%22%3A0%2C%22p%22%3A%7B%22k%22%3A%5B%22data%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A10%2C%22i%22%3A1%2C%22p%22%3A%7B%22k%22%3A%5B%22type%22%2C%22id%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A1%2C%22s%22%3A%22movie%22%7D%2C%7B%22t%22%3A0%2C%22s%22%3A77743%7D%5D%7D%2C%22o%22%3A0%7D%5D%7D%2C%22o%22%3A0%7D%2C%22f%22%3A127%2C%22m%22%3A%5B%5D%7D

payload: {"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["type","id"],"v":[{"t":1,"s":"movie"},{"t":0,"s":777443}]},"o":0}]},"o":0},"f":127,"m":[]}

这里 movie 是一个影片类型，也支持tv 也就是ttId对应的类型。
777443 是影片的 tmdbID，也是catalog返回的id

获取剧集列表：

curl 'https://trybox.app/_serverFn/e554914846470475f9970c596196d2e827879f8fdf88f392107c1218acba9687?payload=%7B%22t%22%3A%7B%22t%22%3A10%2C%22i%22%3A0%2C%22p%22%3A%7B%22k%22%3A%5B%22data%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A10%2C%22i%22%3A1%2C%22p%22%3A%7B%22k%22%3A%5B%22id%22%2C%22season%22%5D%2C%22v%22%3A%5B%7B%22t%22%3A0%2C%22s%22%3A80752%7D%2C%7B%22t%22%3A0%2C%22s%22%3A1%7D%5D%7D%2C%22o%22%3A0%7D%5D%7D%2C%22o%22%3A0%7D%2C%22f%22%3A127%2C%22m%22%3A%5B%5D%7D' \
-H 'x-trybox-lang: zh-CN' \
-H 'Host: trybox.app' \
-H 'Connection: close' \
--proxy http://localhost:9090

payload={"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["id","season"],"v":[{"t":0,"s":80752},{"t":0,"s":1}]},"o":0}]},"o":0},"f":127,"m":[]}



返回数据：
```
{
  "t": 10,
  "i": 0,
  "p": {
    "k": [
      "result",
      "error",
      "context"
    ],
    "v": [
      {
        "t": 9,
        "i": 1,
        "a": [
          {
            "t": 10,
            "i": 2,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1854398
                },
                {
                  "t": 0,
                  "s": 1
                },
                {
                  "t": 1,
                  "s": "烈焰之神"
                },
                {
                  "t": 1,
                  "s": "阿肯尼村庄遭到猎巫者军队袭击，求生之旅就此展开。"
                },
                {
                  "t": 1,
                  "s": "/sXMYCIALBMYTrimBeJqcqpmpeuB.jpg"
                },
                {
                  "t": 0,
                  "s": 57
                },
                {
                  "t": 1,
                  "s": "2019-11-01"
                },
                {
                  "t": 0,
                  "s": 7.551
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 3,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1963459
                },
                {
                  "t": 0,
                  "s": 2
                },
                {
                  "t": 1,
                  "s": "瓶中信"
                },
                {
                  "t": 1,
                  "s": "双胞胎的独特天赋让众人陷入紧张气氛。"
                },
                {
                  "t": 1,
                  "s": "/jnBZ9eY01nzNAWPf691UySZVcI0.jpg"
                },
                {
                  "t": 0,
                  "s": 56
                },
                {
                  "t": 1,
                  "s": "2019-11-01"
                },
                {
                  "t": 0,
                  "s": 7.352
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 4,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1963460
                },
                {
                  "t": 0,
                  "s": 3
                },
                {
                  "t": 1,
                  "s": "新鲜血脉"
                },
                {
                  "t": 1,
                  "s": "双胞胎努力守住一个秘密，不让母亲知晓。"
                },
                {
                  "t": 1,
                  "s": "/3Mq2p5o2DR5VbNiVOOqqU0nf1X2.jpg"
                },
                {
                  "t": 0,
                  "s": 50
                },
                {
                  "t": 1,
                  "s": "2019-11-01"
                },
                {
                  "t": 0,
                  "s": 7.98
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 5,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1963461
                },
                {
                  "t": 0,
                  "s": 4
                },
                {
                  "t": 1,
                  "s": "河流"
                },
                {
                  "t": 1,
                  "s": "村庄遭受突袭，有人做出牺牲，也有人面临新的挑战。"
                },
                {
                  "t": 1,
                  "s": "/A5Lqm0M3UJFPjyUNXfVhYQRnooI.jpg"
                },
                {
                  "t": 0,
                  "s": 52
                },
                {
                  "t": 1,
                  "s": "2019-11-08"
                },
                {
                  "t": 0,
                  "s": 6.922
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 6,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1978444
                },
                {
                  "t": 0,
                  "s": 5
                },
                {
                  "t": 1,
                  "s": "真实面貌"
                },
                {
                  "t": 1,
                  "s": "塔玛奇俊的军队逼近巴霸一家，玛格拉的过去也随之揭开。"
                },
                {
                  "t": 1,
                  "s": "/oYkGfl1ulpm0e6gps8uvLub2Ky1.jpg"
                },
                {
                  "t": 0,
                  "s": 51
                },
                {
                  "t": 1,
                  "s": "2019-11-15"
                },
                {
                  "t": 0,
                  "s": 7.189
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 7,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1984161
                },
                {
                  "t": 0,
                  "s": 6
                },
                {
                  "t": 1,
                  "s": "丝绸"
                },
                {
                  "t": 1,
                  "s": "巴霸一家人惨遭背叛。新的冲突来临，凯恩女王狡猾以对。"
                },
                {
                  "t": 1,
                  "s": "/4G7UsI5SdNXgv4OTWQQ83JBSfD9.jpg"
                },
                {
                  "t": 0,
                  "s": 54
                },
                {
                  "t": 1,
                  "s": "2019-11-22"
                },
                {
                  "t": 0,
                  "s": 7.22
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 8,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1991851
                },
                {
                  "t": 0,
                  "s": 7
                },
                {
                  "t": 1,
                  "s": "薰衣草之路"
                },
                {
                  "t": 1,
                  "s": "双胞胎在前往启蒙之屋的路上面临抉择。"
                },
                {
                  "t": 1,
                  "s": "/6fTXWzWPU8uqljCbKhF1J5qdWHU.jpg"
                },
                {
                  "t": 0,
                  "s": 49
                },
                {
                  "t": 1,
                  "s": "2019-11-28"
                },
                {
                  "t": 0,
                  "s": 7.329
                }
              ]
            },
            "o": 0
          },
          {
            "t": 10,
            "i": 9,
            "p": {
              "k": [
                "id",
                "episode_number",
                "name",
                "overview",
                "still_path",
                "runtime",
                "air_date",
                "vote_average"
              ],
              "v": [
                {
                  "t": 0,
                  "s": 1999042
                },
                {
                  "t": 0,
                  "s": 8
                },
                {
                  "t": 1,
                  "s": "启蒙之屋"
                },
                {
                  "t": 1,
                  "s": "双胞胎见到杰拉玛瑞，终于了解一切真相。"
                },
                {
                  "t": 1,
                  "s": "/1yqnFbSZskNfIpqULdjmA2ruxzR.jpg"
                },
                {
                  "t": 0,
                  "s": 55
                },
                {
                  "t": 1,
                  "s": "2019-12-06"
                },
                {
                  "t": 0,
                  "s": 7.474
                }
              ]
            },
            "o": 0
          }
        ],
        "o": 0
      },
      {
        "t": 2,
        "s": 1
      },
      {
        "t": 11,
        "i": 10,
        "p": {
          "k": [],
          "v": []
        },
        "o": 0
      }
    ]
  },
  "o": 0
}
```



### stream


movie： https://trybox.app/movie/374720/play
tv: https://trybox.app/tv/76331/play?s=1&e=2

```
curl 'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012' \
-X POST \
-H 'Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImYzMzBhOTk4LTE2NGQtNGRmOC04NDNjLTFjODJlZWMxZDQ5YSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3NhaWNoY3V3emJuY3VxbnFodXVsLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJiNTY0MGQ2Mi1mN2EzLTRkMmEtYjUyMC1kYmYyOGVjNDE3YjAiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzkxNzEwNDY3LCJpYXQiOjE3OTE3MDY4NjcsImVtYWlsIjoid2FuZ196aV9tb0AxNjMuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6IndhbmdfemlfbW9AMTYzLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInN1YiI6ImI1NjQwZDYyLWY3YTMtNGQyYS1iNTIwLWRiZjI4ZWM0MTdiMCJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im90cCIsInRpbWVzdGFtcCI6MTc5MTY5NDQ4MX1dLCJzZXNzaW9uX2lkIjoiZjk3YjRmYjQtNGZhMC00NTQ2LWFjNDctNjU3ZTUzNGZhZTVjIiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.iTwfJ4vEMu0tCHy0ZhfoFi_0VkmSKvk4A7E11P6ipj3a-vy9Hp3kEkVfkwS0ZO0qTjfv3jadIn3lVSN-6Eg8Qg' \
-H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15' \
-H 'Host: trybox.app' \
-H 'Connection: close' \
-H 'Content-Length: 161' \
-H 'Content-Type: application/json' \
--data-raw '{"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["tmdb_id","kind"],"v":[{"t":0,"s":687163},{"t":1,"s":"movie"}]},"o":0}]},"o":0},"f":127,"m":[]}' \



curl 'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012' \
-X POST \
-H 'Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImYzMzBhOTk4LTE2NGQtNGRmOC04NDNjLTFjODJlZWMxZDQ5YSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3NhaWNoY3V3emJuY3VxbnFodXVsLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJiNTY0MGQ2Mi1mN2EzLTRkMmEtYjUyMC1kYmYyOGVjNDE3YjAiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzkxNzEwNDY3LCJpYXQiOjE3OTE3MDY4NjcsImVtYWlsIjoid2FuZ196aV9tb0AxNjMuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6IndhbmdfemlfbW9AMTYzLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInN1YiI6ImI1NjQwZDYyLWY3YTMtNGQyYS1iNTIwLWRiZjI4ZWM0MTdiMCJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6Im90cCIsInRpbWVzdGFtcCI6MTc5MTY5NDQ4MX1dLCJzZXNzaW9uX2lkIjoiZjk3YjRmYjQtNGZhMC00NTQ2LWFjNDctNjU3ZTUzNGZhZTVjIiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.iTwfJ4vEMu0tCHy0ZhfoFi_0VkmSKvk4A7E11P6ipj3a-vy9Hp3kEkVfkwS0ZO0qTjfv3jadIn3lVSN-6Eg8Qg' \
-H 'x-trybox-lang: zh-CN' \
-H 'Host: trybox.app' \
-H 'Connection: close' \
-H 'Content-Length: 205' \
-H 'Content-Type: application/json' \
--data-raw '{"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["tmdb_id","kind","season","episode"],"v":[{"t":0,"s":299167},{"t":1,"s":"tv"},{"t":0,"s":1},{"t":0,"s":5}]},"o":0}]},"o":0},"f":127,"m":[]}' \
```

authorization 分析：
这是 Supabase 签发的 JWT，解码后可以看到：

iss: https://saichcuwzbncuqnqhuul.supabase.co/auth/v1
sub: b5640d62-f7a3-4d2a-b520-dbf28ec417b0
email: wang_zi_mo@163.com
role: authenticated
exp: 1791710467（约 1 小时后过期）
session_id: f97b4fb4-4fa0-4546-ac47-657e534fae5c


--data-raw 是 TanStack Start 的序列化格式：，tv和movie的tmdb_id是不同的，season和episode是不同的，所以需要根据不同的类型和参数进行不同的请求。


