import asyncio
from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile
from tortoise.contrib.fastapi import register_tortoise
from ai import inspect_pump
from dtos import Device_Dto, Analysis_Dto, Point_Dto, Warning_Dto
from emulator import spawn_errors
from logic import check_parameter, find_errors
from models import Device, Parameter

load_dotenv()

app = FastAPI(title="KST")

@app.get("/devices/{tag}", response_model=Device_Dto)
async def get_device(tag: str):
    device = await Device.get_or_none(tag=tag)
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    await device.fetch_related("parameters")
    return Device_Dto(tag=device.tag, name=device.name, parameters=sorted([check_parameter(device, p) for p in device.parameters], key=lambda x:x.parameter))

@app.post("/ai/{tag}")
async def ai(tag: str, image: UploadFile) -> Analysis_Dto:
    device = await Device.get_or_none(tag=tag)
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    await device.fetch_related("parameters")

    d = await inspect_pump(image)

    def get_polygon(o):
        return [Point_Dto(x=int(x), y=int(y)) for [x, y] in o["polygon"]]

    corr = [Warning_Dto(label="Ржавчина", points=get_polygon(x)) for x in d["rust"]["regions"]]
    oil = [Warning_Dto(label="Утечка масла", points=get_polygon(x)) for x in d["oil"]["regions"]]

    return Analysis_Dto(
        device_points=get_polygon(d["pump"]),
        warnings= corr + oil,
        errors=find_errors(device, device.parameters, oil[0].points if len(oil) > 0 else [], corr[0].points if len(corr) > 0 else [])
    )


async def spawn():
    await asyncio.sleep(1)
    while True:
        await spawn_errors()

register_tortoise(
    app,
    db_url=os.getenv("DB_URL"),
    modules={"models": ["models"]},
    generate_schemas=True,
    add_exception_handlers=True,
)

asyncio.create_task(spawn())